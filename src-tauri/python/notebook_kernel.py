"""OopsEditor Notebook 内核（仅依赖标准库）。

每个 .ipynb 标签对应一个常驻进程，变量在单元格之间保留。协议是一行一个 JSON：

    stdin  ← {"id": 1, "code": "..."}
    stdout → __OOPS_RESULT__{"id":1,"stdout":"...","stderr":"...","result":"repr","error":null}

设计取舍：
- 不要求安装 ipykernel；执行语义对齐 Jupyter 的“最后一行表达式回显”。
- stdin 被协议占用，用户代码里调用 input() 会抛 RuntimeError。
- 输出在单元格结束时一次性返回，不做流式。
"""

import ast
import io
import json
import sys
import traceback

READY_PREFIX = "__OOPS_READY__"
RESULT_PREFIX = "__OOPS_RESULT__"

_protocol_out = sys.__stdout__
_protocol_in = sys.__stdin__

for _stream in (_protocol_out, _protocol_in):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # 某些嵌入式解释器不支持 reconfigure
        pass


class _NoInput(io.TextIOBase):
    """stdin 被内核协议占用，用户代码不能读它。"""

    def _refuse(self, *args, **kwargs):
        raise RuntimeError("Notebook 内核不支持 input()：stdin 已被内核协议占用")

    read = _refuse
    readline = _refuse
    readlines = _refuse


def _emit(prefix, payload):
    _protocol_out.write(prefix + json.dumps(payload, ensure_ascii=False) + "\n")
    _protocol_out.flush()


def _format_error():
    exc_type, exc_value, tb = sys.exc_info()
    # 包装器自身跑在 <string> 里，栈里只保留用户单元格（文件名 <cell>）的帧
    frames = [frame for frame in traceback.extract_tb(tb) if frame.filename != "<string>"]
    text = "".join(traceback.format_list(frames)) + "".join(
        traceback.format_exception_only(exc_type, exc_value)
    )
    return {
        "ename": getattr(exc_type, "__name__", "Error"),
        "evalue": str(exc_value),
        "traceback": text,
    }


NAMESPACE = {"__name__": "__main__"}


def _run_cell(code):
    stdout = io.StringIO()
    stderr = io.StringIO()
    saved_out, saved_err = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = stdout, stderr
    result = None
    error = None
    try:
        tree = ast.parse(code, "<cell>", "exec")
        last_expression = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            node = tree.body.pop()
            last_expression = ast.Expression(node.value)
            ast.fix_missing_locations(last_expression)

        if tree.body:
            exec(compile(tree, "<cell>", "exec"), NAMESPACE)

        if last_expression is not None:
            value = eval(compile(last_expression, "<cell>", "eval"), NAMESPACE)
            if value is not None:
                NAMESPACE["_"] = value
                try:
                    result = repr(value)
                except Exception as exc:  # repr 自身出错时也要把结果交回来
                    result = "<repr 失败: %s>" % exc
    except BaseException:
        error = _format_error()
    finally:
        sys.stdout, sys.stderr = saved_out, saved_err

    return {
        "stdout": stdout.getvalue(),
        "stderr": stderr.getvalue(),
        "result": result,
        "error": error,
    }


def main():
    sys.stdin = _NoInput()
    _emit(
        READY_PREFIX,
        {"version": "%d.%d.%d" % sys.version_info[:3], "executable": sys.executable},
    )
    while True:
        line = _protocol_in.readline()
        if not line:
            break
        try:
            request = json.loads(line)
        except Exception:
            continue
        payload = _run_cell(request.get("code", ""))
        payload["id"] = request.get("id")
        _emit(RESULT_PREFIX, payload)


if __name__ == "__main__":
    main()
