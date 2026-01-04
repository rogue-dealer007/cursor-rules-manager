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
const POSTMORTEMS_PATH = path.join(CONFIG_PATH, 'postmortems.json');

if (!fs.existsSync(CONFIG_PATH)) fs.mkdirSync(CONFIG_PATH, { recursive: true });
if (!fs.existsSync(USERS_PATH)) fs.mkdirSync(USERS_PATH, { recursive: true });
if (!fs.existsSync(GLOBAL_RULES_PATH)) fs.writeFileSync(GLOBAL_RULES_PATH, `# Global Cursor Rules\n\n## Files to Always Read\n\n## Core Instructions\n`);
if (!fs.existsSync(PROJECTS_CONFIG_PATH)) fs.writeFileSync(PROJECTS_CONFIG_PATH, JSON.stringify({ projects: [], scanPaths: [HOME] }, null, 2));
if (!fs.existsSync(POSTMORTEMS_PATH)) fs.writeFileSync(POSTMORTEMS_PATH, JSON.stringify({ postmortems: [] }, null, 2));

const ENCRYPTION_KEY = crypto.createHash('sha256').update(os.hostname() + os.userInfo().username).digest();
function encrypt(text) { const iv = crypto.randomBytes(16); const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, iv); return iv.toString('hex') + ':' + cipher.update(text, 'utf8', 'hex') + cipher.final('hex'); }
function decrypt(text) { try { const [ivHex, encrypted] = text.split(':'); const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, Buffer.from(ivHex, 'hex')); return decipher.update(encrypted, 'hex', 'utf8') + decipher.final('utf8'); } catch { return null; } }

function getUserDataPath(userId) { return path.join(USERS_PATH, `${userId.replace(/[^a-zA-Z0-9]/g, '_')}.json`); }
function getUserData(userId) { const p = getUserDataPath(userId); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : { apiKey: null }; }
function saveUserData(userId, data) { fs.writeFileSync(getUserDataPath(userId), JSON.stringify(data, null, 2)); }
function getConfig() { return JSON.parse(fs.readFileSync(PROJECTS_CONFIG_PATH, 'utf-8')); }
function saveConfig(config) { fs.writeFileSync(PROJECTS_CONFIG_PATH, JSON.stringify(config, null, 2)); }
function getPostmortems() { return JSON.parse(fs.readFileSync(POSTMORTEMS_PATH, 'utf-8')); }
function savePostmortems(data) { fs.writeFileSync(POSTMORTEMS_PATH, JSON.stringify(data, null, 2)); }

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
            projects.push({ name: entry.name, path: projectPath, hasCursorRules: hasCursor && fs.existsSync(path.join(projectPath, '.cursor', 'rules')) });
          }
        }
      }
    } catch (e) { console.error(`Error scanning ${scanPath}:`, e.message); }
  }
  return projects;
}

// Standard API routes
app.get('/api/global-rules', (req, res) => res.json({ content: fs.readFileSync(GLOBAL_RULES_PATH, 'utf-8') }));
app.post('/api/global-rules', (req, res) => { fs.writeFileSync(GLOBAL_RULES_PATH, req.body.content); res.json({ success: true }); });
app.get('/api/scan-paths', (req, res) => res.json({ scanPaths: getConfig().scanPaths || [] }));
app.post('/api/scan-paths', (req, res) => { const c = getConfig(); c.scanPaths = req.body.scanPaths; saveConfig(c); res.json({ success: true }); });
app.get('/api/user/:userId/api-key-status', (req, res) => { const d = getUserData(req.params.userId); if (d.apiKey) { const dec = decrypt(d.apiKey); if (dec) return res.json({ hasKey: true, keyPreview: `${dec.slice(0, 10)}...${dec.slice(-4)}` }); } res.json({ hasKey: false }); });
app.post('/api/user/:userId/api-key', (req, res) => { const d = getUserData(req.params.userId); d.apiKey = encrypt(req.body.apiKey); saveUserData(req.params.userId, d); res.json({ success: true }); });
app.get('/api/projects', async (req, res) => res.json({ projects: await scanForProjects(getConfig().scanPaths || []) }));

app.get('/api/projects/:projectPath/rules', (req, res) => {
  const projectPath = Buffer.from(req.params.projectPath, 'base64').toString('utf-8');
  const rulesPath = path.join(projectPath, '.cursor', 'rules');
  if (!fs.existsSync(rulesPath)) return res.json({ rules: [] });
  const files = fs.readdirSync(rulesPath).filter(f => f.endsWith('.mdc') || f.endsWith('.md'));
  res.json({ rules: files.map(file => { const content = fs.readFileSync(path.join(rulesPath, file), 'utf-8'); const parsed = matter(content); return { filename: file, frontmatter: parsed.data, content: parsed.content, raw: content }; }) });
});

app.post('/api/projects/:projectPath/rules', (req, res) => {
  const projectPath = Buffer.from(req.params.projectPath, 'base64').toString('utf-8');
  const rulesPath = path.join(projectPath, '.cursor', 'rules');
  if (!fs.existsSync(path.join(projectPath, '.cursor'))) fs.mkdirSync(path.join(projectPath, '.cursor'), { recursive: true });
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
  try { res.json({ files: (await glob('**/*', { cwd: projectPath, ignore: ['node_modules/**', '.git/**', '.next/**', 'dist/**', 'build/**', '.cursor/**'], nodir: true, maxDepth: 5 })).slice(0, 200) }); }
  catch (e) { res.json({ files: [] }); }
});

app.post('/api/generate-rule', (req, res) => {
  const { name, description, globs, alwaysApply, mustReadFiles, instructions } = req.body;
  let content = '---\n';
  if (description) content += `description: "${description}"\n`;
  if (globs?.length) content += `globs: ${JSON.stringify(globs)}\n`;
  if (alwaysApply) content += `alwaysApply: true\n`;
  content += '---\n\n';
  if (mustReadFiles?.length) { content += `# Files You MUST Read\n\nBefore doing ANYTHING, read these files:\n\n`; mustReadFiles.forEach(f => content += `- \`${f}\`\n`); content += `\n**DO NOT proceed without reading these files first.**\n\n`; }
  if (instructions) content += `# Instructions\n\n${instructions}\n`;
  res.json({ content, filename: `${name || 'rule'}.mdc` });
});

// ============ POSTMORTEM SYSTEM ============

// Get all postmortems
app.get('/api/postmortems', (req, res) => {
  const data = getPostmortems();
  res.json(data);
});

// Add a postmortem
app.post('/api/postmortems', (req, res) => {
  const data = getPostmortems();
  const postmortem = {
    id: Date.now().toString(),
    timestamp: new Date().toISOString(),
    project: req.body.project || 'global',
    whatBroke: req.body.whatBroke,
    filesShouldRead: req.body.filesShouldRead || [],
    wrongAssumptions: req.body.wrongAssumptions,
    suggestedRule: req.body.suggestedRule,
    severity: req.body.severity || 'minor',
    rawDump: req.body.rawDump
  };
  data.postmortems.unshift(postmortem);
  savePostmortems(data);
  res.json({ success: true, postmortem });
});

// Delete a postmortem
app.delete('/api/postmortems/:id', (req, res) => {
  const data = getPostmortems();
  data.postmortems = data.postmortems.filter(p => p.id !== req.params.id);
  savePostmortems(data);
  res.json({ success: true });
});

// Clear all postmortems
app.delete('/api/postmortems', (req, res) => {
  savePostmortems({ postmortems: [] });
  res.json({ success: true });
});

// Analyze patterns in postmortems and generate rules
app.post('/api/postmortems/analyze', async (req, res) => {
  const { userId } = req.body;
  
  let apiKey = null;
  if (userId) { const d = getUserData(userId); if (d.apiKey) apiKey = decrypt(d.apiKey); }
  if (!apiKey) return res.status(400).json({ error: 'No API key. Add in Settings.' });

  const data = getPostmortems();
  if (!data.postmortems.length) return res.status(400).json({ error: 'No postmortems to analyze.' });

  const postmortemSummary = data.postmortems.map(p => `
[${p.severity.toUpperCase()}] ${p.timestamp}
Project: ${p.project}
What broke: ${p.whatBroke || p.rawDump || 'N/A'}
Files should read: ${p.filesShouldRead?.join(', ') || 'N/A'}
Wrong assumptions: ${p.wrongAssumptions || 'N/A'}
Suggested rule: ${p.suggestedRule || 'N/A'}
`).join('\n---\n');

  const systemPrompt = `You are an expert at analyzing AI coding assistant failures and creating preventive rules.

You will receive a collection of "postmortems" - records of times when an AI assistant made mistakes, broke things, or didn't understand the codebase properly.

Your job is to:
1. IDENTIFY PATTERNS - What types of mistakes keep happening?
2. FIND ROOT CAUSES - Why does the AI keep making these mistakes?
3. GENERATE RULES - Create Cursor rules that would PREVENT these issues
4. PRIORITIZE - Which rules would have the highest impact?

For each suggested rule, provide:
- A clear name
- Whether it should be GLOBAL (applies everywhere) or PROJECT-specific
- Rating: "critical" (must have), "important" (should have), "nice" (good to have)
- The actual rule content
- Which postmortems it addresses

Also provide:
- An overall health assessment
- The #1 thing that would improve AI interactions
- Any contradictory patterns you notice

Return JSON:
{
  "analysis": {
    "totalPostmortems": 0,
    "patterns": ["pattern 1", "pattern 2"],
    "rootCauses": ["cause 1", "cause 2"],
    "healthScore": "poor|fair|good|excellent",
    "topRecommendation": "The single most impactful change"
  },
  "rules": [
    {
      "name": "rule-name",
      "scope": "global|project",
      "priority": "critical|important|nice",
      "description": "Short description",
      "mustReadFiles": ["file1.ts"],
      "instructions": "Detailed rule content",
      "addressesPostmortems": ["id1", "id2"],
      "rationale": "Why this rule helps"
    }
  ],
  "warnings": ["Any concerning patterns or contradictions"]
}`;

  try {
    console.log('Analyzing postmortems...');
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Analyze these ${data.postmortems.length} postmortems and generate preventive rules:\n\n${postmortemSummary}` }
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' }
      })
    });

    const result = await response.json();
    if (result.error) return res.status(400).json({ error: result.error.message });
    if (!result.choices?.[0]?.message?.content) return res.status(500).json({ error: 'Unexpected response' });

    res.json(JSON.parse(result.choices[0].message.content));
  } catch (e) {
    console.error('Analysis error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Quick postmortem from raw dump
app.post('/api/postmortems/quick', async (req, res) => {
  const { rawDump, project, userId } = req.body;
  
  let apiKey = null;
  if (userId) { const d = getUserData(userId); if (d.apiKey) apiKey = decrypt(d.apiKey); }
  
  // If no API key, just save the raw dump
  if (!apiKey) {
    const data = getPostmortems();
    const postmortem = {
      id: Date.now().toString(),
      timestamp: new Date().toISOString(),
      project: project || 'global',
      rawDump,
      severity: 'minor'
    };
    data.postmortems.unshift(postmortem);
    savePostmortems(data);
    return res.json({ success: true, postmortem, parsed: false });
  }

  // Parse the raw dump with AI
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: `Parse this postmortem dump into structured data. Return JSON:
{
  "whatBroke": "concise description",
  "filesShouldRead": ["file paths mentioned"],
  "wrongAssumptions": "what AI assumed incorrectly",
  "suggestedRule": "informal rule that would prevent this",
  "severity": "minor|major|critical"
}` },
          { role: 'user', content: rawDump }
        ],
        temperature: 0.2,
        response_format: { type: 'json_object' }
      })
    });

    const result = await response.json();
    const parsed = JSON.parse(result.choices[0].message.content);

    const data = getPostmortems();
    const postmortem = {
      id: Date.now().toString(),
      timestamp: new Date().toISOString(),
      project: project || 'global',
      rawDump,
      ...parsed
    };
    data.postmortems.unshift(postmortem);
    savePostmortems(data);
    res.json({ success: true, postmortem, parsed: true });
  } catch (e) {
    // Fallback to raw save
    const data = getPostmortems();
    const postmortem = { id: Date.now().toString(), timestamp: new Date().toISOString(), project: project || 'global', rawDump, severity: 'minor' };
    data.postmortems.unshift(postmortem);
    savePostmortems(data);
    res.json({ success: true, postmortem, parsed: false });
  }
});

// AI Format Rules (existing)
app.post('/api/ai/format-rules', async (req, res) => {
  const { rawInput, projectContext, userId, sanityCheckMode } = req.body;
  
  let apiKey = null;
  if (userId) { const d = getUserData(userId); if (d.apiKey) apiKey = decrypt(d.apiKey); }
  if (!apiKey) return res.status(400).json({ error: 'No API key. Add in Settings.' });
  
  const systemPrompt = sanityCheckMode ? `You are an expert code reviewer that converts raw notes into Cursor AI rules.

For EACH rule, evaluate against best practices and provide:
- rating: "good" (conventional), "caution" (trade-offs), or "bad" (anti-pattern)
- rationale: Why you gave that rating
- conflicts: Any conflicts with common practices
- alternatives: Better approaches if rating is bad/caution

Return JSON:
{
  "rules": [{ "name": "kebab-case", "description": "Short desc", "category": "api|structure|state|files|conventions", "alwaysApply": true, "mustReadFiles": [], "instructions": "Markdown instructions", "rating": "good|caution|bad", "ratingEmoji": "✅|⚠️|❌", "rationale": "Why", "conflicts": [], "alternatives": "" }],
  "summary": { "good": 0, "caution": 0, "bad": 0, "overallAdvice": "Brief assessment" }
}

Be HONEST. Flag anti-patterns, over-engineering, violations of DRY/SOLID.`
  : `Convert raw notes into Cursor AI rules. Return JSON:
{
  "rules": [{ "name": "kebab-case", "description": "Short desc", "category": "api|structure|state|files|conventions", "alwaysApply": true, "mustReadFiles": [], "instructions": "Markdown instructions" }]
}`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: `Project: ${projectContext || 'General'}\n\nRaw input:\n\n${rawInput}` }], temperature: 0.3, response_format: { type: 'json_object' } })
    });
    const result = await response.json();
    if (result.error) return res.status(400).json({ error: result.error.message });
    res.json(JSON.parse(result.choices[0].message.content));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3847;
app.listen(PORT, () => console.log(`\n🎯 Cursor Rules Manager running at http://localhost:${PORT}\n`));
