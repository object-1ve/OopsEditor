const fs = require('fs');
const yaml = fs.readFileSync('.github/workflows/release.yml', 'utf8');
console.log('File size:', yaml.length, 'bytes');
console.log('First line:', yaml.split('\n')[0]);
console.log('Has name:', yaml.includes('name: Build and Release'));
console.log('Has on.push.tags:', yaml.includes('tags:'));
console.log('Has jobs.build:', yaml.includes('build:'));
console.log('Has jobs.build-macos:', yaml.includes('build-macos:'));
console.log('Has jobs.release:', yaml.includes('release:'));
// check all lines
const lines = yaml.split('\n');
lines.forEach((l, i) => {
  if (l.includes('npm run tbuild')) {
    console.log(`Line ${i+1}: ${l}`);
  }
});
