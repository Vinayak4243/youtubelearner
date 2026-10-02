# 🎓 AdaptPractice
**AI-Powered Adaptive Learning Environment**

AdaptPractice is a sophisticated learning platform that transforms any YouTube video or playlist into a structured, interactive course. By leveraging Large Language Models (LLMs), it generates customized lesson plans, identifies key concepts, and tracks student mastery through evidence-based practice.

## 🚀 Features

- **AI Course Generation**: Convert a YouTube playlist URL into a full course with structured lessons and a roadmap.
- **Dynamic Concept Tracking**: The system doesn't just track "completion"; it tracks **mastery**. It uses a custom algorithm to determine if a student is "learning," "improving," or has "mastered" a specific concept.
- **AI-Generated Assignments**: Automatically creates Multiple Choice (MCQ), True/False, and short-answer questions based on the course material.
- **Personalized Explanations**: A "Confuse Me" feature that allows students to pinpoint a exact timestamp in a video and get a simplified AI explanation of that specific moment.
- **Multi-Provider AI Backend**: Supports **GPT-4o**, **Google Gemini**, and **Local Ollama** models for maximum flexibility and cost-efficiency.
- **Focus Shield**: A productivity mode to minimize distractions during study sessions.

## 🛠️ Technical Stack

- **Frontend**: Vanilla JavaScript (SPA Architecture), CSS3, HTML5.
- **Backend**: Node.js, Express.
- **AI Integration**: Anthropic Claude / OpenAI GPT-4o / Google Gemini API.
- **Infrastructure**: Vercel (Serverless Functions), GitHub Actions.
- **Tools**: `yt-dlp` for high-performance YouTube metadata extraction.

## ⚙️ Installation & Setup

### Local Development
1. Clone the repository:
   ```bash
   git clone https://github.com/Vinayak4243/Youtubelearner.git
   cd Youtubelearner
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create a `.env` file in the root directory:
   ```env
   YOUTUBE_API_KEY=your_youtube_key
   GEMINI_API_KEY=your_gemini_key
   OPENAI_API_KEY=your_openai_key
   ```
4. Start the server:
   ```bash
   node server.js
   ```

### Authentication and Supabase

Copy `.env.example` to `.env` and set `SUPABASE_URL` and
`SUPABASE_PUBLISHABLE_KEY` from **Supabase Dashboard → Project Settings → API**.
Use the Project URL (the `https://<project-ref>.supabase.co` origin), not the
REST endpoint ending in `/rest/v1/`.
The publishable key (the `sb_publishable_...` key) is used only by server
functions; the browser does not receive a Supabase key. `SUPABASE_ANON_KEY` is
also accepted for older projects. Do not set or use a service-role/secret key
for this app.

Set `AUTH_SITE_URL` to the canonical site origin, with no trailing slash. For
the production deployment, use:

```env
AUTH_SITE_URL=https://youtubelearner-five.vercel.app
```

In Vercel, add `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and
`AUTH_SITE_URL` under **Project → Settings → Environment Variables** for every
environment that should support accounts, then redeploy. In Supabase, enable
the **Email** auth provider, set the Site URL to the same origin, and add
`https://youtubelearner-five.vercel.app/**` to the allowed redirect URLs.
The app returns from email confirmation at `/?auth=verify` and password reset
at `/?auth=reset`.

The migration in
[`supabase/migrations/202610020001_adaptpractice.sql`](./supabase/migrations/202610020001_adaptpractice.sql)
creates the learner tables, including `learner_snapshots` and
`user_rate_limits`, and enables per-user row-level security policies. To apply
it in Supabase, open **SQL Editor → New query**, paste the complete contents
of that migration file, and run it against the intended project. If it has
already been applied, do not run it again just to configure authentication.
Verify that `learner_snapshots` and `user_rate_limits` exist and that RLS is
enabled before testing account data sync.

## 📈 Mastery Logic
The app uses an evidence-based update system. Mastery is not a simple percentage but a weighted score:
- **Correct Answer**: Increases mastery significantly.
- **Correct with Hint**: Increases mastery slightly.
- **Incorrect Answer**: Decreases mastery and flags the concept as a "weakness" if errors persist.

---
Developed by **Vinayak4243** as part of a Bachelor's degree project.
