//! 图片附件导入：文件名 = `<可读词干>-<内容 sha256 前 16 位>.<扩展名>`。
//!
//! 哈希直接写在文件名里，于是「找重复」只是一次文件名扫描 —— 不需要数据库，
//! 也不会因为外部移动/删除文件而失效：
//!   1. 先在作用域（md 文件所属的根目录，见 `search_root`）内的 Attachment 目录里
//!      找带同一哈希的文件，比对内容一致即复用，markdown 里写相对引用；
//!   2. 没命中就写到 md 同级的 Attachment 目录。

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fmt::Write as _;
use std::fs;
use std::path::{Component, Path, PathBuf};

/// 图片固定存放的目录名（md 文件同级）
const ATTACHMENT_DIR: &str = "Attachment";
/// 文件名中保留的哈希字符数（64 bit；10 万张图片撞车概率约 2.7e-9）
const HASH_LEN: usize = 16;
/// 可读词干保留的最大字符数，避免超长路径
const MAX_STEM_LEN: usize = 32;
const FALLBACK_STEM: &str = "image";
const FALLBACK_EXT: &str = "png";
/// 扫描护栏：根目录可能选得很宽（甚至整个盘符），限制深度与目录数避免卡死
const MAX_SCAN_DEPTH: usize = 10;
const MAX_SCAN_DIRS: usize = 20_000;
/// 明显不是笔记目录的重目录，扫描时直接跳过
const SKIP_DIRS: [&str; 2] = ["node_modules", "target"];

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ImageImport {
    /// 最终文件名（所在 Attachment 目录内）
    pub filename: String,
    /// 图片完整路径（正斜杠）
    pub path: String,
    /// markdown 中使用的相对引用（相对 md 文件所在目录，正斜杠）
    pub reference: String,
    /// md 文件所在目录（正斜杠）
    pub parent_dir: String,
    /// 图片所在目录（正斜杠）
    pub save_dir: String,
    /// true = 复用了已存在的图片（未写入新文件）
    pub reused: bool,
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(hex, "{:02x}", byte);
    }
    hex
}

fn to_slash(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

/// 路径拆成用于比较的分量（丢掉根分隔符；Windows 盘符保留为第一段）
fn path_parts(path: &Path) -> Vec<String> {
    path.components()
        .filter_map(|c| match c {
            Component::Prefix(p) => Some(p.as_os_str().to_string_lossy().to_string()),
            Component::RootDir | Component::CurDir => None,
            Component::ParentDir => Some("..".to_string()),
            Component::Normal(s) => Some(s.to_string_lossy().to_string()),
        })
        .collect()
}

fn component_eq(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

/// 计算 markdown 引用用的相对路径；跨盘符等无法相对表示时返回 None
fn relative_reference(from_dir: &Path, target: &Path) -> Option<String> {
    let from = path_parts(from_dir);
    let to = path_parts(target);
    if from.is_empty() || to.is_empty() || !component_eq(&from[0], &to[0]) {
        return None;
    }
    let common = from
        .iter()
        .zip(&to)
        .take_while(|(a, b)| component_eq(a, b))
        .count();
    let mut parts: Vec<String> = std::iter::repeat_n("..".to_string(), from.len() - common).collect();
    parts.extend(to[common..].iter().cloned());
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

/// 复用范围：md 文件所属的、层级最深的根目录；不在任何根目录内时退化为它自己所在目录
fn search_root(from_dir: &Path, scope_roots: &[String]) -> PathBuf {
    let from = path_parts(from_dir);
    let mut best: Option<(usize, PathBuf)> = None;
    for root in scope_roots {
        let candidate = Path::new(root);
        let parts = path_parts(candidate);
        if parts.is_empty() || parts.len() > from.len() {
            continue;
        }
        if !parts.iter().zip(&from).all(|(a, b)| component_eq(a, b)) {
            continue;
        }
        if best.as_ref().map_or(true, |(depth, _)| parts.len() > *depth) {
            best = Some((parts.len(), candidate.to_path_buf()));
        }
    }
    best.map(|(_, path)| path)
        .unwrap_or_else(|| from_dir.to_path_buf())
}

fn is_attachment_dir(path: &Path) -> bool {
    path.file_name()
        .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case(ATTACHMENT_DIR))
}

/// 文件名（去掉扩展名后）是否以 `-<hash>` 结尾
fn has_hash_suffix(file_name: &str, hash_suffix: &str) -> bool {
    let stem = match file_name.rfind('.') {
        Some(idx) if idx > 0 => &file_name[..idx],
        _ => file_name,
    };
    stem.len()
        .checked_sub(hash_suffix.len())
        .is_some_and(|idx| stem.is_char_boundary(idx) && stem[idx..].eq_ignore_ascii_case(hash_suffix))
}

/// 内容一致才算命中：防止「同名但被手工替换过」的文件被当成复用对象
fn content_matches(path: &Path, bytes: &[u8]) -> bool {
    match fs::metadata(path) {
        Ok(meta) if meta.len() == bytes.len() as u64 => {
            fs::read(path).is_ok_and(|content| content == bytes)
        }
        _ => false,
    }
}

/// 在单个 Attachment 目录里按文件名筛哈希，命中后再比对内容
fn find_in_attachment_dir(
    dir: &Path,
    hash_suffix: &str,
    bytes: &[u8],
) -> Option<PathBuf> {
    for entry in fs::read_dir(dir).ok()?.flatten() {
        if !entry.file_type().is_ok_and(|kind| kind.is_file())
            || !has_hash_suffix(&entry.file_name().to_string_lossy(), hash_suffix)
        {
            continue;
        }
        let path = entry.path();
        if content_matches(&path, bytes) {
            return Some(path);
        }
    }
    None
}

/// 在作用域内查找内容相同的已有附件：先按文件名筛哈希，命中后再读文件比对内容。
/// 同目录优先（最常见的重复粘贴），未命中才扫作用域，多个候选取相对引用最近的。
fn find_existing(
    from_dir: &Path,
    scope_roots: &[String],
    hash_suffix: &str,
    bytes: &[u8],
) -> Option<PathBuf> {
    let local = find_in_attachment_dir(&from_dir.join(ATTACHMENT_DIR), hash_suffix, bytes);
    if local.is_some() {
        return local;
    }

    let mut best: Option<(usize, usize, PathBuf)> = None;
    let mut visited = 0usize;
    let mut stack = vec![(search_root(from_dir, scope_roots), 0usize)];

    while let Some((dir, depth)) = stack.pop() {
        if visited >= MAX_SCAN_DIRS {
            break;
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        visited += 1;
        let in_attachment_dir = is_attachment_dir(&dir);

        for entry in entries.flatten() {
            let path = entry.path();
            if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                let name = entry.file_name().to_string_lossy().to_string();
                if depth < MAX_SCAN_DEPTH && !name.starts_with('.') && !SKIP_DIRS.contains(&name.as_str()) {
                    stack.push((path, depth + 1));
                }
            } else if in_attachment_dir && has_hash_suffix(&entry.file_name().to_string_lossy(), hash_suffix) {
                let Some(reference) = relative_reference(from_dir, &path) else {
                    continue;
                };
                let rank = (reference.matches("..").count(), reference.len());
                if best.as_ref().is_none_or(|(hops, len, _)| rank < (*hops, *len))
                    && content_matches(&path, bytes)
                {
                    best = Some((rank.0, rank.1, path));
                }
            }
        }
    }

    best.map(|(_, _, path)| path)
}

/// 取 `foo/bar/baz.PNG` 中的 `baz`
fn file_stem_of(raw_name: &str) -> &str {
    let name = raw_name.rsplit(['/', '\\']).next().unwrap_or(raw_name);
    match name.rfind('.') {
        Some(idx) if idx > 0 => &name[..idx],
        _ => name,
    }
}

/// 摘掉 `image-3f9ac2b1c2d3e4f5` 这类由本模块生成的尾部哈希，
/// 让「把已导入的附件再次拖进来」保持文件名稳定（否则哈希会层层叠加）
fn strip_hash_suffix(stem: &str) -> &str {
    match stem.rsplit_once('-') {
        Some((head, tail))
            if (HASH_LEN..=64).contains(&tail.len())
                && tail.chars().all(|c| c.is_ascii_hexdigit()) =>
        {
            head
        }
        _ => stem,
    }
}

/// 从来源文件名提取可读词干：去掉路径/扩展名/非法字符，并限制长度
fn normalized_stem(raw_name: &str) -> String {
    let cleaned: String = file_stem_of(raw_name)
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    let stem: String = strip_hash_suffix(&cleaned)
        .trim_matches(['-', '_'])
        .chars()
        .take(MAX_STEM_LEN)
        .collect();
    let stem = stem.trim_matches(['-', '_']);
    if stem.is_empty() {
        FALLBACK_STEM.to_string()
    } else {
        stem.to_string()
    }
}

/// 扩展名统一小写；非法或缺失时回退为 png
fn normalized_ext(raw_name: &str) -> String {
    let name = raw_name.rsplit(['/', '\\']).next().unwrap_or(raw_name);
    let ext = match name.rfind('.') {
        Some(idx) if idx > 0 && idx + 1 < name.len() => name[idx + 1..].to_ascii_lowercase(),
        _ => return FALLBACK_EXT.to_string(),
    };
    if ext.len() <= 8 && ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        ext
    } else {
        FALLBACK_EXT.to_string()
    }
}

fn import_result(from_dir: &Path, path: &Path, reused: bool) -> Result<ImageImport, String> {
    Ok(ImageImport {
        filename: path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        path: to_slash(path),
        reference: relative_reference(from_dir, path).ok_or_else(|| "无法计算图片相对路径".to_string())?,
        parent_dir: to_slash(from_dir),
        save_dir: path
            .parent()
            .map(to_slash)
            .unwrap_or_else(|| to_slash(from_dir)),
        reused,
    })
}

/// 按内容哈希落盘：先在作用域内复用同内容的图片，没有再写入 md 同级的 Attachment 目录。
pub fn store_attachment(
    md_path: &Path,
    scope_roots: &[String],
    bytes: &[u8],
    raw_name: &str,
) -> Result<ImageImport, String> {
    if bytes.is_empty() {
        return Err("图片内容为空".to_string());
    }
    let parent_dir = md_path
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .ok_or_else(|| "当前文件尚未保存到磁盘，请先保存文件".to_string())?;

    let hash = sha256_hex(bytes);
    let hash_suffix = format!("-{}", &hash[..HASH_LEN]);

    if let Some(existing) = find_existing(parent_dir, scope_roots, &hash_suffix, bytes) {
        return import_result(parent_dir, &existing, true);
    }

    let save_dir = parent_dir.join(ATTACHMENT_DIR);
    fs::create_dir_all(&save_dir).map_err(|e| format!("创建图片目录失败: {}", e))?;

    let stem = normalized_stem(raw_name);
    let ext = normalized_ext(raw_name);
    let mut path = save_dir.join(format!("{}-{}.{}", stem, &hash[..HASH_LEN], ext));
    if path.exists() {
        // 同名但内容不同：用户手工替换过该文件（或极小概率哈希前缀撞车），不覆盖，改用完整哈希
        path = save_dir.join(format!("{}-{}.{}", stem, hash, ext));
    }

    fs::write(&path, bytes).map_err(|e| format!("保存图片失败: {}", e))?;
    import_result(parent_dir, &path, false)
}

/// 导入磁盘上的图片文件（拖放/选择文件）；`scope_roots` 为前端侧边栏根目录，限定复用范围
#[tauri::command]
pub fn import_image_file(
    md_path: String,
    scope_roots: Vec<String>,
    source_path: String,
) -> Result<ImageImport, String> {
    let bytes = fs::read(&source_path).map_err(|e| format!("读取图片失败: {}", e))?;
    let raw_name = Path::new(&source_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    store_attachment(Path::new(&md_path), &scope_roots, &bytes, &raw_name)
}

/// 导入 base64 图片（剪贴板粘贴）；`scope_roots` 为前端侧边栏根目录，限定复用范围
#[tauri::command]
pub fn import_image_base64(
    md_path: String,
    scope_roots: Vec<String>,
    data: String,
    name: Option<String>,
) -> Result<ImageImport, String> {
    let compact: String = data.chars().filter(|c| !c.is_whitespace()).collect();
    let bytes = STANDARD
        .decode(compact.as_bytes())
        .map_err(|e| format!("解析图片数据失败: {}", e))?;
    let raw_name = name.unwrap_or_else(|| format!("{}.{}", FALLBACK_STEM, FALLBACK_EXT));
    store_attachment(Path::new(&md_path), &scope_roots, &bytes, &raw_name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static FIXTURE_SEQ: AtomicU64 = AtomicU64::new(0);

    /// 根目录/子目录/md 文件的测试夹具
    struct Fixture {
        root: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            // 并行测试 + Windows 粗粒度时钟会让同 tick 的 nanos 重名，加线程 id 与序列号隔离。
            let root = std::env::temp_dir().join(format!(
                "oops-attachment-test-{}-{}-{:?}-{}",
                std::process::id(),
                SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos(),
                std::thread::current().id(),
                FIXTURE_SEQ.fetch_add(1, Ordering::SeqCst)
            ));
            fs::create_dir_all(&root).unwrap();
            Self { root }
        }

        fn note(&self, relative_dir: &str) -> PathBuf {
            let dir = self.root.join(relative_dir);
            fs::create_dir_all(&dir).unwrap();
            let note = dir.join("note.md");
            fs::write(&note, "# note\n").unwrap();
            note
        }

        fn roots(&self) -> Vec<String> {
            vec![self.root.to_string_lossy().replace('\\', "/")]
        }

        fn file_count(&self, relative_dir: &str) -> usize {
            fs::read_dir(self.root.join(relative_dir))
                .map(|entries| entries.count())
                .unwrap_or(0)
        }

        fn cleanup(&self) {
            fs::remove_dir_all(&self.root).unwrap();
        }
    }

    #[test]
    fn same_content_reuses_existing_file() {
        let fixture = Fixture::new();
        let note = fixture.note("");
        let roots = fixture.roots();

        let first = store_attachment(&note, &roots, b"PNG-BYTES", "image.png").unwrap();
        let second = store_attachment(&note, &roots, b"PNG-BYTES", "image.png").unwrap();

        assert!(!first.reused);
        assert!(second.reused);
        assert_eq!(first.filename, second.filename);
        assert_eq!(second.reference, first.reference);
        assert!(second.reference.starts_with("Attachment/"), "reference: {}", second.reference);
        assert_eq!(fixture.file_count("Attachment"), 1, "重复内容不应产生第二个文件");
        fixture.cleanup();
    }

    #[test]
    fn reuses_across_folders_within_scope() {
        let fixture = Fixture::new();
        let note_a = fixture.note("A");
        let note_b = fixture.note("B");
        let roots = fixture.roots();

        let first = store_attachment(&note_a, &roots, b"SHARED-IMAGE", "diagram.png").unwrap();
        let second = store_attachment(&note_b, &roots, b"SHARED-IMAGE", "diagram.png").unwrap();

        assert!(!first.reused);
        assert!(second.reused, "跨文件夹应复用同一份图片");
        assert_eq!(second.filename, first.filename);
        assert_eq!(second.reference, format!("../A/Attachment/{}", first.filename));
        // B 目录下不应出现新的图片文件
        assert_eq!(fixture.file_count("B"), 1, "B 目录里只有 note.md");
        fixture.cleanup();
    }

    #[test]
    fn keeps_separate_copies_outside_scope() {
        let fixture = Fixture::new();
        let note_a = fixture.note("A");
        let note_b = fixture.note("B");

        let first = store_attachment(&note_a, &[], b"SAME-BYTES", "diagram.png").unwrap();
        // 没有根目录 → 复用范围退化为 md 自己所在目录，跨文件夹不复用
        let second = store_attachment(&note_b, &[], b"SAME-BYTES", "diagram.png").unwrap();

        assert!(!first.reused && !second.reused);
        assert_eq!(second.reference, format!("Attachment/{}", first.filename));
        assert_eq!(fixture.file_count("B/Attachment"), 1);
        fixture.cleanup();
    }

    #[test]
    fn different_content_creates_second_file() {
        let fixture = Fixture::new();
        let note = fixture.note("");
        let roots = fixture.roots();

        let a = store_attachment(&note, &roots, b"AAA", "image.png").unwrap();
        let b = store_attachment(&note, &roots, b"BBB", "image.png").unwrap();

        assert_ne!(a.filename, b.filename);
        assert!(!b.reused);
        assert_eq!(fixture.file_count("Attachment"), 2);
        // 文件名保留可读词干与扩展名：[stem]-[hash16].png
        assert!(a.filename.starts_with("image-"), "filename: {}", a.filename);
        assert!(a.filename.ends_with(".png"), "filename: {}", a.filename);
        fixture.cleanup();
    }

    #[test]
    fn reimporting_attachment_keeps_name_stable() {
        let fixture = Fixture::new();
        let note = fixture.note("");
        let roots = fixture.roots();

        let first = store_attachment(&note, &roots, b"DIAGRAM", "diagram.png").unwrap();
        // 把已导入的附件当作来源再次导入：词干去掉旧哈希后应命中同一文件
        let source = fixture.root.join("Attachment").join(&first.filename);
        let again = store_attachment(&note, &roots, b"DIAGRAM", &source.to_string_lossy()).unwrap();

        assert!(again.reused);
        assert_eq!(again.filename, first.filename);
        assert_eq!(fixture.file_count("Attachment"), 1);
        fixture.cleanup();
    }

    #[test]
    fn sanitizes_source_name() {
        let fixture = Fixture::new();
        let note = fixture.note("");
        let result = store_attachment(&note, &[], b"X", "My Screenshot!!.PNG").unwrap();

        assert!(result.filename.starts_with("MyScreenshot-"), "filename: {}", result.filename);
        assert!(result.filename.ends_with(".png"), "filename: {}", result.filename);
        fixture.cleanup();
    }

    #[test]
    fn tampered_file_is_preserved() {
        let fixture = Fixture::new();
        let note = fixture.note("");
        let roots = fixture.roots();

        let original = store_attachment(&note, &roots, b"ORIGINAL", "image.png").unwrap();
        fs::write(fixture.root.join("Attachment").join(&original.filename), b"EDITED-BY-USER").unwrap();

        let again = store_attachment(&note, &roots, b"ORIGINAL", "image.png").unwrap();

        assert!(!again.reused);
        assert_ne!(again.filename, original.filename);
        // 用户改过的文件保持原样，新内容另存一份
        assert_eq!(
            fs::read(fixture.root.join("Attachment").join(&original.filename)).unwrap(),
            b"EDITED-BY-USER"
        );
        fixture.cleanup();
    }

    #[test]
    fn rejects_empty_image() {
        let fixture = Fixture::new();
        let note = fixture.note("");
        assert!(store_attachment(&note, &[], b"", "image.png").is_err());
        fixture.cleanup();
    }

    #[test]
    fn base64_command_dedups_with_whitespace_tolerance() {
        let fixture = Fixture::new();
        let note = fixture.note("");
        let roots = fixture.roots();
        let md = note.to_string_lossy().replace('\\', "/");
        let payload = STANDARD.encode(b"CLIPBOARD-PNG");

        let first = import_image_base64(md.clone(), roots.clone(), payload.clone(), Some("image.png".into()))
            .unwrap();
        // 剪贴板 base64 可能带换行，应同样命中复用
        let wrapped = format!("{}\n{}", &payload[..4], &payload[4..]);
        let second = import_image_base64(md, roots, wrapped, Some("image.png".into())).unwrap();

        assert!(!first.reused && second.reused);
        assert_eq!(first.filename, second.filename);
        assert_eq!(fixture.file_count("Attachment"), 1);
        fixture.cleanup();
    }

    #[test]
    fn file_command_dedups_same_content() {
        let fixture = Fixture::new();
        let note = fixture.note("");
        let roots = fixture.roots();
        let md = note.to_string_lossy().replace('\\', "/");
        let source = fixture.root.join("shot.png");
        fs::write(&source, b"SHOT-BYTES").unwrap();
        let source_path = source.to_string_lossy().to_string();

        let first = import_image_file(md.clone(), roots.clone(), source_path.clone()).unwrap();
        let second = import_image_file(md, roots, source_path).unwrap();

        assert!(!first.reused && second.reused);
        assert_eq!(first.filename, second.filename);
        assert!(first.filename.starts_with("shot-"));
        assert_eq!(fixture.file_count("Attachment"), 1);
        fixture.cleanup();
    }

    /// 临时基准：量一下「文件名扫描」在像样的笔记树上的耗时（用完即删）
    #[test]
    #[ignore]
    fn bench_scan_cost() {
        use std::time::Instant;

        /// 按真实内容哈希命名写入一张图，返回其内容
        fn seed(attachment_dir: &std::path::Path, seed: usize) -> Vec<u8> {
            let mut content = vec![0u8; 1024];
            content[..8].copy_from_slice(&(seed as u64).to_le_bytes());
            let name = format!("image-{}.png", &sha256_hex(&content)[..HASH_LEN]);
            fs::write(attachment_dir.join(name), &content).unwrap();
            content
        }

        fn vault(root: &std::path::Path, folders: usize) -> Vec<PathBuf> {
            let mut notes = Vec::new();
            for i in 0..folders {
                let dir = root.join(format!("folder{i:03}"));
                fs::create_dir_all(dir.join("Attachment")).unwrap();
                for j in 0..20 {
                    seed(&dir.join("Attachment"), i * 100 + j);
                }
                let note = dir.join("note.md");
                fs::write(&note, "# note\n").unwrap();
                notes.push(note);
            }
            notes
        }

        let fixture = Fixture::new();
        let notes = vault(&fixture.root, 500);
        let roots = fixture.roots();
        let note = notes.last().unwrap().clone();

        let mut time_it = |label: &str, runs: usize, f: &mut dyn FnMut() -> bool| {
            let mut best = u128::MAX;
            let mut reused = false;
            for _ in 0..runs {
                let start = Instant::now();
                reused = f();
                best = best.min(start.elapsed().as_millis());
            }
            println!("{label}: {best} ms (reused={reused})");
        };

        // A. 同目录命中（重复粘贴同一张图，最常见）
        let local_content = seed(&note.parent().unwrap().join("Attachment"), 999_999);
        time_it("A 同目录命中 (1000dirs/10k files)", 3, &mut || {
            store_attachment(&note, &roots, &local_content, "image.png").unwrap().reused
        });

        // B. 跨文件夹命中（同一根目录下别的文件夹里已有）
        let mut cross_content = vec![0u8; 1024];
        cross_content[..8].copy_from_slice(&0u64.to_le_bytes());
        time_it("B 跨文件夹命中 (需扫全树)", 3, &mut || {
            store_attachment(&note, &roots, &cross_content, "image.png").unwrap().reused
        });

        // C. 未命中：扫全树后写入新图（只测首次）
        let start = Instant::now();
        let miss = store_attachment(&note, &roots, b"BRAND-NEW-IMAGE", "image.png").unwrap();
        println!("C 未命中(写入新图): {} ms (reused={})", start.elapsed().as_millis(), miss.reused);

        let small = Fixture::new();
        let small_notes = vault(&small.root, 20);
        let small_roots = small.roots();
        let small_note = small_notes.last().unwrap().clone();
        let mut big = vec![7u8; 4 * 1024 * 1024];
        for counter in 1..=4u64 {
            big[..8].copy_from_slice(&counter.to_le_bytes());
            let start = Instant::now();
            let _ = store_attachment(&small_note, &small_roots, &big, "big.png").unwrap();
            println!("D 4MB 新图落盘 (40dirs): {} ms", start.elapsed().as_millis());
        }

        let start = Instant::now();
        let _ = sha256_hex(&big);
        println!("SHA256 4MB: {} ms (debug build)", start.elapsed().as_millis());

        fixture.cleanup();
        small.cleanup();
    }
}
