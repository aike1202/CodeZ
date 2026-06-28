const fs = require('fs');
const path = require('path');
const base64Data = "iVBORw0KGgoAAAANSUhEUgAAAQAAAAEAAQMAAABmvDolAAAAA1BMVEUAAACnej3aAAAAAXRSTlMAQObYZgAAAENJREFUeNrtwTEBAAAAwiD7p7bGDmAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAkNwAQAAGU/HhgAAAAAElFTkSuQmCC"; // 256x256 black png
fs.mkdirSync('build', { recursive: true });
fs.writeFileSync('build/icon.png', Buffer.from(base64Data, 'base64'));
console.log('Dummy icon created at build/icon.png');
