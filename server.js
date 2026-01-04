const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const { glob } = require('glob');
const os = require('os');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const HOME = os.homedir();
const CONFIG_PATH = path.join(HOME, '.cursor-rules-manager');
const GLOBAL_RULES_PATH = path.join(CONFIG_PATH, 'global-rules.md');
const PROJECTS_CONFIG_PATH = path.join(CONFIG_PATH, 'projects.json');

// Ensure config directory exists
if (!fs.existsSync(CONFIG_PATH)) {
  fs.mkdirSync(CONFIG_PATH, { recursive: true });
}

// Initialize global rules file if not exists
if (!fs.existsSync(GLOBAL_RULES_PATH)) {
  fs.writeFileSync(GLOBAL_RULES_PATH, `# Global Cursor Rules

## Files to Always Read
<!-- List files that should ALWAYS be read before any task -->

## Core Instructions
<!-- Your global instructions here -->
`);
}

// Initialize projects config if not exists
if (!fs.existsSync(PROJECTS_CONFIG_PATH)) {
  fs.writeFileSync(PROJECTS_CONFIG_PATH, JSON.stringify({ projects: [], scanPaths: [path.join(HOME, 'code'), path.join(HOME, 'projects'), path.join(HOME, 'dev')] }, null, 2));
}

// Get config
function getConfig() {
  return JSON.parse(fs.readFileSync(PROJECTS_CONFIG_PATH, 'utf-8'));
}

// Save config
function saveConfig(config) {
  fs.writeFileSync(PROJECTS_CONFIG_PATH, JSON.stringify(config, null, 2));
}

// Scan for Cursor projects (folders with .cursor or .git)
async function scanForProjects(scanPaths) {
  const projects = [];
  
  for (const scanPath of scanPaths) {
    if (!fs.existsSync(scanPath)) continue;
    
    try {
      const entries = fs.readdirSync(scanPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const projectPath = path.join(scanPath, entry.name);
          const hasCursor = fs.existsSync(path.join(projectPath, '.cursor'));
          const hasGit = fs.existsSync(path.join(projectPath, '.git'));
          
          if (hasCursor || hasGit) {
            projects.push({
              name: entry.name,
              path: projectPath,
              hasCursorRules: hasCursor && fs.existsSync(path.join(projectPath, '.cursor', 'rules'))
            });
          }
        }
      }
    } catch (e) {
      console.error(`Error scanning ${scanPath}:`, e.message);
    }
  }
  
  return projects;
}

// API: Get global rules
app.get('/api/global-rules', (req, res) => {
  const content = fs.readFileSync(GLOBAL_RULES_PATH, 'utf-8');
  res.json({ content });
});

// API: Save global rules
app.post('/api/global-rules', (req, res) => {
  const { content } = req.body;
  fs.writeFileSync(GLOBAL_RULES_PATH, content);
  res.json({ success: true });
});

// API: Get scan paths
app.get('/api/scan-paths', (req, res) => {
  const config = getConfig();
  res.json({ scanPaths: config.scanPaths || [] });
});

// API: Update scan paths
app.post('/api/scan-paths', (req, res) => {
  const { scanPaths } = req.body;
  const config = getConfig();
  config.scanPaths = scanPaths;
  saveConfig(config);
  res.json({ success: true });
});

// API: Scan and list projects
app.get('/api/projects', async (req, res) => {
  const config = getConfig();
  const projects = await scanForProjects(config.scanPaths || []);
  res.json({ projects });
});

// API: Get project rules
app.get('/api/projects/:projectPath/rules', (req, res) => {
  const projectPath = Buffer.from(req.params.projectPath, 'base64').toString('utf-8');
  const rulesPath = path.join(projectPath, '.cursor', 'rules');
  
  if (!fs.existsSync(rulesPath)) {
    return res.json({ rules: [] });
  }
  
  const files = fs.readdirSync(rulesPath).filter(f => f.endsWith('.mdc') || f.endsWith('.md'));
  const rules = files.map(file => {
    const content = fs.readFileSync(path.join(rulesPath, file), 'utf-8');
    const parsed = matter(content);
    return {
      filename: file,
      frontmatter: parsed.data,
      content: parsed.content,
      raw: content
    };
  });
  
  res.json({ rules });
});

// API: Save project rule
app.post('/api/projects/:projectPath/rules', (req, res) => {
  const projectPath = Buffer.from(req.params.projectPath, 'base64').toString('utf-8');
  const { filename, content } = req.body;
  const rulesPath = path.join(projectPath, '.cursor', 'rules');
  
  // Ensure directories exist
  if (!fs.existsSync(path.join(projectPath, '.cursor'))) {
    fs.mkdirSync(path.join(projectPath, '.cursor'), { recursive: true });
  }
  if (!fs.existsSync(rulesPath)) {
    fs.mkdirSync(rulesPath, { recursive: true });
  }
  
  fs.writeFileSync(path.join(rulesPath, filename), content);
  res.json({ success: true });
});

// API: Delete project rule
app.delete('/api/projects/:projectPath/rules/:filename', (req, res) => {
  const projectPath = Buffer.from(req.params.projectPath, 'base64').toString('utf-8');
  const { filename } = req.params;
  const filePath = path.join(projectPath, '.cursor', 'rules', filename);
  
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
  
  res.json({ success: true });
});

// API: List files in project (for file picker)
app.get('/api/projects/:projectPath/files', async (req, res) => {
  const projectPath = Buffer.from(req.params.projectPath, 'base64').toString('utf-8');
  
  try {
    const files = await glob('**/*', {
      cwd: projectPath,
      ignore: ['node_modules/**', '.git/**', '.next/**', 'dist/**', 'build/**', '.cursor/**'],
      nodir: true,
      maxDepth: 5
    });
    res.json({ files: files.slice(0, 200) }); // Limit to 200 files
  } catch (e) {
    res.json({ files: [] });
  }
});

// API: Generate MDC rule content
app.post('/api/generate-rule', (req, res) => {
  const { name, description, globs, alwaysApply, mustReadFiles, instructions } = req.body;
  
  let content = '---\n';
  if (description) content += `description: "${description}"\n`;
  if (globs && globs.length) content += `globs: ${JSON.stringify(globs)}\n`;
  if (alwaysApply) content += `alwaysApply: true\n`;
  content += '---\n\n';
  
  if (mustReadFiles && mustReadFiles.length) {
    content += `# Files You MUST Read\n\n`;
    content += `Before doing ANYTHING, you MUST read and understand these files:\n\n`;
    mustReadFiles.forEach(f => {
      content += `- \`${f}\`\n`;
    });
    content += `\n**DO NOT proceed without reading these files first.**\n\n`;
  }
  
  if (instructions) {
    content += `# Instructions\n\n${instructions}\n`;
  }
  
  res.json({ content, filename: `${name || 'rule'}.mdc` });
});

const PORT = process.env.PORT || 3847;
app.listen(PORT, () => {
  console.log(`\n🎯 Cursor Rules Manager running at http://localhost:${PORT}\n`);
});
