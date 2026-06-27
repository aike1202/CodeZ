const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const sourceFile = path.join(rootDir, 'project.rule.md');

const targets = [
  path.join(rootDir, '.cursorrules'),
  path.join(rootDir, '.clinerules'),
  path.join(rootDir, '.agents', 'AGENTS.md')
];

if (!fs.existsSync(sourceFile)) {
  console.error(`Error: Source file ${sourceFile} not found.`);
  process.exit(1);
}

try {
  const content = fs.readFileSync(sourceFile, 'utf8');

  targets.forEach(target => {
    const targetDir = path.dirname(target);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    fs.writeFileSync(target, content, 'utf8');
    console.log(`Synced rules to: ${path.relative(rootDir, target)}`);
  });

  console.log('Successfully aligned all rule files.');
} catch (error) {
  console.error('Failed to sync rules:', error);
  process.exit(1);
}
