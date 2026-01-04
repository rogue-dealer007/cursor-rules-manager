const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const { glob } = require('glob');
const os = require('os');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

const HOME = os.homedir();
const CONFIG_PATH = path.join(HOME, '.cursor-rules-manager');
const GLOBAL_RULES_PATH = path.join(CONFIG_PATH, 'global-rules.md');
const PROJECTS_CONFIG_PATH = path.join(CONFIG_PATH, 'projects.json');
const USERS_PATH = path.join(CONFIG_PATH, 'users');

// Ensure directories exist
if (!fs.existsSync(CONFIG_PATH)) fs.mkdirSync(CONFIG_PATH, { recursive: true });
if (!fs.existsSync(USERS_PATH)) fs.mkdirSync(USERS_PATH, { recursive: true });

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

// Simple encryption for API keys (using machine-specific key)
const ENCRYPTION_KEY = crypto.createHash('sha256').update(os.hostname() + os.userInfo().username).digest();

function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decrypt(text) {
  try {
    const [ivHex, encrypted] = text.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    return null;
  }
}

// Get user data file path
function getUserDataPath(userId) {
  const safeId = userId.replace(/[^a-zA-Z0-9]/g, '_');
  return path.join(USERS_PATH, `${safeId}.json`);
}

// Get user data
function getUserData(userId) {
  const filePath = getUserDataPath(userId);
  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  }
  return { apiKey: null };
}

// Save user data
function saveUserData(userId, data) {
  const filePath = getUserDataPath(userId);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// Get config
function getConfig() {
  return JSON.parse(fs.readFileSync(PROJECTS_CONFIG_PATH, 'utf-8'));
}

// Save config
function saveConfig(config) {
  fs.writeFileSync(PROJECTS_CONFIG_PATH, JSON.stringify(config, null, 2));
}

// Scan for Cursor projects
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

// API: Get user's API key status
app.get('/api/user/:userId/api-key-status', (req, res) => {
  const { userId } = req.params;
  const userData = getUserData(userId);
  
  if (userData.apiKey) {
    const decrypted = decrypt(userData.apiKey);
    if (decrypted) {
      res.json({ 
        hasKey: true, 
        keyPreview: `${decrypted.slice(0, 10)}...${decrypted.slice(-4)}` 
      });
      return;
    }
  }
  res.json({ hasKey: false, keyPreview: null });
});

// API: Save user's API key (encrypted)
app.post('/api/user/:userId/api-key', (req, res) => {
  const { userId } = req.params;
  const { apiKey } = req.body;
  
  const userData = getUserData(userId);
  userData.apiKey = encrypt(apiKey);
  saveUserData(userId, userData);
  
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
  
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  res.json({ success: true });
});

// API: List files in project
app.get('/api/projects/:projectPath/files', async (req, res) => {
  const projectPath = Buffer.from(req.params.projectPath, 'base64').toString('utf-8');
  
  try {
    const files = await glob('**/*', {
      cwd: projectPath,
      ignore: ['node_modules/**', '.git/**', '.next/**', 'dist/**', 'build/**', '.cursor/**'],
      nodir: true,
      maxDepth: 5
    });
    res.json({ files: files.slice(0, 200) });
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
    mustReadFiles.forEach(f => content += `- \`${f}\`\n`);
    content += `\n**DO NOT proceed without reading these files first.**\n\n`;
  }
  
  if (instructions) content += `# Instructions\n\n${instructions}\n`;
  
  res.json({ content, filename: `${name || 'rule'}.mdc` });
});

// API: AI Format Rules
app.post('/api/ai/format-rules', async (req, res) => {
  const { rawInput, projectContext, userId } = req.body;
  
  // Get API key for user
  let apiKey = null;
  if (userId) {
    const userData = getUserData(userId);
    if (userData.apiKey) {
      apiKey = decrypt(userData.apiKey);
    }
  }
  
  if (!apiKey) {
    return res.status(400).json({ error: 'No API key found. Please add your OpenAI API key in Settings.' });
  }
  
  try {
    console.log('Calling OpenAI API...');
    
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: `You are a helpful assistant that converts raw notes, bug descriptions, and informal rules into properly formatted Cursor AI rules.

Your job is to:
1. Parse the user's raw input (could be messy notes, bug descriptions, informal rules)
2. Extract distinct rules from the input
3. Format each rule with a clear name, description, and instructions
4. Suggest which files should be marked as "must read" if mentioned

Return a JSON object with a "rules" array in this exact format:
{
  "rules": [
    {
      "name": "rule-name-kebab-case",
      "description": "Short description for frontmatter",
      "category": "api|structure|state|files|conventions",
      "alwaysApply": true,
      "mustReadFiles": ["path/to/file.ts"],
      "instructions": "Detailed instructions in markdown format"
    }
  ]
}

Be thorough - extract ALL distinct rules from the input. Group related items together.
Use clear, imperative language in instructions.
If files are mentioned, include them in mustReadFiles.`
          },
          {
            role: 'user',
            content: `Project context: ${projectContext || 'General project'}\n\nRaw input to convert into rules:\n\n${rawInput}`
          }
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' }
      })
    });
    
    const data = await response.json();
    console.log('OpenAI response:', JSON.stringify(data, null, 2));
    
    if (data.error) {
      console.error('OpenAI API error:', data.error);
      return res.status(400).json({ error: data.error.message || 'OpenAI API error' });
    }
    
    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
      console.error('Unexpected response format:', data);
      return res.status(500).json({ error: 'Unexpected response from OpenAI' });
    }
    
    const parsed = JSON.parse(data.choices[0].message.content);
    res.json(parsed);
  } catch (e) {
    console.error('Error calling OpenAI:', e);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3847;
app.listen(PORT, () => {
  console.log(`\n🎯 Cursor Rules Manager running at http://localhost:${PORT}\n`);
});
