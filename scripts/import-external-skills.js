const fs = require('fs');
const path = require('path');
const os = require('os');

const codezGlobalSkillsDir = path.join(os.homedir(), '.codez', 'skills');
const codexSkillsDir = path.join(os.homedir(), '.codex', 'skills');
const claudeSkillsDir = path.join(os.homedir(), '.claude', 'skills');

if (!fs.existsSync(codezGlobalSkillsDir)) {
  fs.mkdirSync(codezGlobalSkillsDir, { recursive: true });
}

function copyDirectory(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(srcPath, destPath);
    } else {
      if (!fs.existsSync(destPath)) {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }
}

function importSkills(sourceDir, sourceName) {
  if (!fs.existsSync(sourceDir)) {
    console.log(`Source directory ${sourceDir} does not exist. Skipping.`);
    return;
  }

  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  let importedCount = 0;

  for (const entry of entries) {
    const srcSkillPath = path.join(sourceDir, entry.name);
    let isDir = false;
    try {
      isDir = fs.statSync(srcSkillPath).isDirectory();
    } catch (e) {}

    if (isDir && !entry.name.startsWith('.')) {
      const destSkillPath = path.join(codezGlobalSkillsDir, entry.name);

      // Check if it's a valid skill folder (contains SKILL.md or is just a folder we can copy)
      if (fs.existsSync(path.join(srcSkillPath, 'SKILL.md'))) {
        if (!fs.existsSync(destSkillPath)) {
          console.log(`Importing skill '${entry.name}' from ${sourceName}...`);
          copyDirectory(srcSkillPath, destSkillPath);
          importedCount++;
        } else {
          console.log(`Skill '${entry.name}' already exists in Codez. Skipping.`);
        }
      }
    }
  }
  console.log(`Successfully imported ${importedCount} skills from ${sourceName}.`);
}

console.log('--- Starting Skill Import ---');
importSkills(codexSkillsDir, 'Codex');
importSkills(claudeSkillsDir, 'Claude');
console.log('--- Import Complete ---');
