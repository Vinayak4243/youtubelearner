# AdaptPractice — Learn Anything. Practice Intelligently.

AdaptPractice is an adaptive learning web application featuring course creation, YouTube video/playlist ingestion, lesson workspaces, adaptive quiz generation, intelligent mistake classification, the weakness matrix, spaced revision, and roadmaps.

## 🌐 Live Web Version
The app is published and running live on Vercel:
- **Production URL**: [https://youtubelearner.vercel.app](https://youtubelearner.vercel.app)
- **Team Alias**: [https://youtubelearner-adaptedge-academy.vercel.app](https://youtubelearner-adaptedge-academy.vercel.app)

---

## 🚀 Quick Start (Run Locally)

### 1. Install dependencies
```bash
npm install
```

### 2. Configure AI (Optional for local use)
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

You can choose your AI backend:
- **Anthropic Claude**: Set `ANTHROPIC_API_KEY=sk-ant-...`
- **Google Gemini**: Set `GEMINI_API_KEY=AIzaSy...`
- **Local Ollama**: Run Ollama locally (`ollama run qwen2.5:3b`) with `USE_OLLAMA=true`

*(Note: Even without an API key, browsing, manual course creation, note taking, and weakness tracking work fully offline!)*

### 3. Start the server
```bash
npm start
# or for live reloading during development:
npm run dev
```

Open **http://localhost:8787** in your browser.

---

## 🔑 Activating AI on the Live Web

On the published web app, you can activate AI in two easy ways:

1. **In-Browser Configuration (Recommended)**:
   - Navigate to **Profile** in the sidebar.
   - Under **AI Configuration**, paste your Anthropic or Google Gemini API key.
   - Click **Save API Key**. All AI features unlock immediately for your session.
2. **Vercel Project Environment Variables**:
   - In your Vercel Project Settings → Environment Variables, add `ANTHROPIC_API_KEY` or `GEMINI_API_KEY`.
   - Any redeployment will automatically activate AI features globally.

---

## 📁 Project Architecture

```
public/
  index.html     HTML shell with Google Fonts & PDF.js
  styles.css     Modern design tokens, animations, responsive layout & dark mode
  app.js         Complete client app: state machine, views, adaptive scoring
api/
  index.js       Vercel Serverless Function entry point
server.js        Express server serving static assets and API routes
claude.js        Multi-provider AI backend (Anthropic Claude, Google Gemini, Ollama)
vercel.json      Vercel Edge CDN rewrites and routing configuration
```

---

## 🚢 Deploying Updates to Vercel

To publish new changes to production:

```bash
npx vercel --prod
```
