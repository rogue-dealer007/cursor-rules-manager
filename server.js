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

if (!fs.existsSync(CONFIG_PATH)) fs.mkdirSync(CONFIG_PATH, { recursive: true });
if (!fs.existsSync(USERS_PATH)) fs.mkdirSync(USERS_PATH, { recursive: true });

if (!fs.existsSync(GLOBAL_RULES_PATH)) {
  fs.writeFileSync(GLOBAL_RULES_PATH, `# Global Cursor Rules\n\n## Files to Always Read\n\n## Core Instructions\n`);
}

if (!fs.existsSync(PROJECTS_CONFIG_PATH)) {
  fs.writeFileSync(PROJECTS_CONFIG_PATH, JSON.stringify({ projects: [], scanPaths: [path.join(HOME)] }, null, 2));
}

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
  } catch { return null; }
}

function getUserDataPath(userId) {
  return path.join(USERS_PATH, `${userId.replace(/[^a-zA-Z0-9]/g, '_')}.json`);
}

function getUserData(userId) {
  const filePath = getUserDataPath(userId);
  if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  return { apiKey: null };
}

function saveUserData(userId, data) {
  fs.writeFileSync(getUserDataPath(userId), JSON.stringify(data, null, 2));
}

function getConfig() { return JSON.parse(fs.readFileSync(PROJECTS_CONFIG_PATH, 'utf-8')); }
function saveConfig(config) { fs.writeFileSync(PROJECTS_CONFIG_PATH, JSON.stringify(config, null, 2)); }

async function scanForProjects(scanPaths) {
  const projects = [];
  for (const scanPath of scanPaths) {
    if (!fs.existsSync(scanPath)) continue;
    try {
      const entries = fs.readdirSync(scanPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
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
    } catch (e) { console.error(`Error scanning ${scanPath}:`, e.message); }
  }
  return projects;
}

// API Routes
app.get('/api/global-rules', (req, res) => {
  res.json({ content: fs.readFileSync(GLOBAL_RULES_PATH, 'utf-8') });
});

app.post('/api/global-rules', (req, res) => {
  fs.writeFileSync(GLOBAL_RULES_PATH, req.body.content);
  res.json({ success: true });
});

app.get('/api/scan-paths', (req, res) => {
  res.json({ scanPaths: getConfig().scanPaths || [] });
});

app.post('/api/scan-paths', (req, res) => {
  const config = getConfig();
  config.scanPaths = req.body.scanPaths;
  saveConfig(config);
  res.json({ success: true });
});

app.get('/api/user/:userId/api-key-status', (req, res) => {
  const userData = getUserData(req.params.userId);
  if (userData.apiKey) {
    const decrypted = decrypt(userData.apiKey);
    if (decrypted) {
      return res.json({ hasKey: true, keyPreview: `${decrypted.slice(0, 10)}...${decrypted.slice(-4)}` });
    }
  }
  res.json({ hasKey: false, keyPreview: null });
});

app.post('/api/user/:userId/api-key', (req, res) => {
  const userData = getUserData(req.params.userId);
  userData.apiKey = encrypt(req.body.apiKey);
  saveUserData(req.params.userId, userData);
  res.json({ success: true });
});

app.get('/api/projects', async (req, res) => {
  res.json({ projects: await scanForProjects(getConfig().scanPaths || []) });
});

app.get('/api/projects/:projectPath/rules', (req, res) => {
  const projectPath = Buffer.from(req.params.projectPath, 'base64').toString('utf-8');
  const rulesPath = path.join(projectPath, '.cursor', 'rules');
  if (!fs.existsSync(rulesPath)) return res.json({ rules: [] });
  
  const files = fs.readdirSync(rulesPath).filter(f => f.endsWith('.mdc') || f.endsWith('.md'));
  const rules = files.map(file => {
    const content = fs.readFileSync(path.join(rulesPath, file), 'utf-8');
    const parsed = matter(content);
    return { filename: file, frontmatter: parsed.data, content: parsed.content, raw: content };
  });
  res.json({ rules });
});

app.post('/api/projects/:projectPath/rules', (req, res) => {
  const projectPath = Buffer.from(req.params.projectPath, 'base64').toString('utf-8');
  const rulesPath = path.join(projectPath, '.cursor', 'rules');
  
  if (!fs.existsSync(path.join(projectPath, '.cursor'))) {
    fs.mkdirSync(path.join(projectPath, '.cursor'), { recursive: true });
  }
  if (!fs.existsSync(rulesPath)) fs.mkdirSync(rulesPath, { recursive: true });
  
  fs.writeFileSync(path.join(rulesPath, req.body.filename), req.body.content);
  res.json({ success: true });
});

app.delete('/api/projects/:projectPath/rules/:filename', (req, res) => {
  const projectPath = Buffer.from(req.params.projectPath, 'base64').toString('utf-8');
  const filePath = path.join(projectPath, '.cursor', 'rules', req.params.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  res.json({ success: true });
});

app.get('/api/projects/:projectPath/files', async (req, res) => {
  const projectPath = Buffer.from(req.params.projectPath, 'base64').toString('utf-8');
  try {
    const files = await glob('**/*', {
      cwd: projectPath,
      ignore: ['node_modules/**', '.git/**', '.next/**', 'dist/**', 'build/**', '.cursor/**'],
      nodir: true, maxDepth: 5
    });
    res.json({ files: files.slice(0, 200) });
  } catch (e) { res.json({ files: [] }); }
});

app.post('/api/generate-rule', (req, res) => {
  const { name, description, globs, alwaysApply, mustReadFiles, instructions } = req.body;
  
  let content = '---\n';
  if (description) content += `description: "${description}"\n`;
  if (globs && globs.length) content += `globs: ${JSON.stringify(globs)}\n`;
  if (alwaysApply) content += `alwaysApply: true\n`;
  content += '---\n\n';
  
  if (mustReadFiles && mustReadFiles.length) {
    content += `# Files You MUST Read\n\nBefore doing ANYTHING, read these files:\n\n`;
    mustReadFiles.forEach(f => content += `- \`${f}\`\n`);
    content += `\n**DO NOT proceed without reading these files first.**\n\n`;
  }
  
  if (instructions) content += `# Instructions\n\n${instructions}\n`;
  
  res.json({ content, filename: `${name || 'rule'}.mdc` });
});

// AI Format Rules with Sanity Check Mode
app.post('/api/ai/format-rules', async (req, res) => {
  const { rawInput, projectContext, userId, sanityCheckMode } = req.body;
  
  let apiKey = null;
  if (userId) {
    const userData = getUserData(userId);
    if (userData.apiKey) apiKey = decrypt(userData.apiKey);
  }
  
  if (!apiKey) {
    return res.status(400).json({ error: 'No API key found. Add your OpenAI API key in Settings.' });
  }
  
  // Different prompts based on sanity check mode
  const systemPrompt = sanityCheckMode ? `You are an expert code reviewer and AI assistant that converts raw notes into Cursor AI rules.

Your job is to:
1. Parse the user's raw input (messy notes, bug descriptions, informal rules)
2. Extract distinct rules from the input
3. Format each rule properly
4. **CRITICALLY EVALUATE** each rule against industry best practices

For EACH rule, you MUST provide:
- A rating: "good" (conventional/recommended), "caution" (works but has trade-offs), or "bad" (anti-pattern/contradicts best practices)
- A brief rationale explaining WHY you gave that rating
- Any conflicts with common practices or other rules

Return a JSON object:
{
  "rules": [
    {
      "name": "rule-name-kebab-case",
      "description": "Short description",
      "category": "api|structure|state|files|conventions",
      "alwaysApply": true,
      "mustReadFiles": ["path/to/file.ts"],
      "instructions": "Detailed instructions in markdown",
      "rating": "good|caution|bad",
      "ratingEmoji": "✅|⚠️|❌",
      "rationale": "Why this rating - reference specific best practices",
      "conflicts": ["List any conflicts with common patterns or other suggested rules"],
      "alternatives": "If rating is bad/caution, suggest better alternatives"
    }
  ],
  "summary": {
    "good": 0,
    "caution": 0,
    "bad": 0,
    "overallAdvice": "Brief overall assessment of these rules"
  }
}

Be HONEST and CRITICAL. Flag anti-patterns like:
- Over-abstraction
- Tight coupling
- Violating DRY/SOLID principles
- Non-conventional file structures
- Unusual API patterns
- Over-engineering
- Under-engineering

If rules contradict each other, flag that explicitly.` 

: `You are a helpful assistant that converts raw notes into Cursor AI rules.

Your job is to:
1. Parse the user's raw input (messy notes, bug descriptions, informal rules)
2. Extract distinct rules from the input
3. Format each rule with a clear name, description, and instructions
4. Suggest which files should be "must read" if mentioned

Return a JSON object:
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

Be thorough - extract ALL distinct rules. Group related items. Use clear, imperative language.`;

  try {
    console.log('Calling OpenAI API... Sanity Check Mode:', sanityCheckMode);
    
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Project context: ${projectContext || 'General project'}\n\nRaw input to convert into rules:\n\n${rawInput}` }
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' }
      })
    });
    
    const data = await response.json();
    console.log('OpenAI response received');
    
    if (data.error) {
      console.error('OpenAI API error:', data.error);
      return res.status(400).json({ error: data.error.message || 'OpenAI API error' });
    }
    
    if (!data.choices?.[0]?.message?.content) {
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
