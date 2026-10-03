# 🎓 AdaptPractice
**AI-Powered Adaptive Learning Environment**

AdaptPractice turns YouTube lessons and PDFs into interactive courses. It generates lessons and practice, tracks mistakes by concept, and uses those records to shape later practice.

## 🚀 Features

- **Source-based courses**: Build a course from YouTube videos, playlists, PDFs, or pasted lesson titles.
- **Dynamic Concept Tracking**: The system doesn't just track "completion"; it tracks **mastery**. It uses a custom algorithm to determine if a student is "learning," "improving," or has "mastered" a specific concept.
- **AI-Generated Assignments**: Automatically creates Multiple Choice (MCQ), True/False, and short-answer questions based on the course material.
- **Personalized Explanations**: Ask for help at a video timestamp using the available transcript context.
- **AI providers**: Google Gemini is the default; OpenAI is an optional provider fallback.
- **Focus Shield**: A productivity mode to minimize distractions during study sessions.

## 🛠️ Technical Stack

- **Frontend**: Vanilla JavaScript (SPA Architecture), CSS3, HTML5.
- **Backend**: Node.js, Express.
- **AI Integration**: Server-side Google Gemini and optional OpenAI APIs.
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
3. Copy `.env.example` to `.env` and configure the required server-side values:
   ```env
   SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
   SUPABASE_PUBLISHABLE_KEY=your-supabase-publishable-key
   AUTH_SITE_URL=http://localhost:8787
   GEMINI_API_KEY=your-gemini-api-key
   ```
   `YOUTUBE_API_KEY` enables playlist metadata loading on Vercel.
   `OPENAI_API_KEY` is optional. Provider credentials are read by the server
   and are never sent to the browser.
4. Use Node.js 24 and start the server:
   ```bash
   npm start
   ```

Run the regression suite with `npm test`.

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
The account screens have their own refreshable hash routes:
`/#/signup`, `/#/signin`, `/#/forgot-password`, and `/#/reset-password`.
Email links must return to the site origin configured in `AUTH_SITE_URL`.

The migration in
[`supabase/migrations/202610020001_adaptpractice.sql`](./supabase/migrations/202610020001_adaptpractice.sql)
creates the learner tables, including `learner_snapshots` and
`user_rate_limits`, and enables per-user row-level security policies. To apply
it in Supabase, open **SQL Editor → New query**, paste the complete contents
of that migration file, and run it against the intended project. If it has
already been applied, do not run it again just to configure authentication.
Verify that `learner_snapshots` and `user_rate_limits` exist and that RLS is
enabled before testing account data sync.

### Runtime environment variables

- Required for accounts: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and
  `AUTH_SITE_URL`. `SUPABASE_ANON_KEY` is accepted as a legacy alternative to
  `SUPABASE_PUBLISHABLE_KEY`.
- At least one AI provider is required: `GEMINI_API_KEY` (default) or
  `OPENAI_API_KEY`. Optional model settings are `GEMINI_MODEL`,
  `GEMINI_FALLBACK_MODEL`, and `GPT_MODEL`.
- Optional YouTube playlist metadata: `YOUTUBE_API_KEY`. Vercel does not use a
  local `yt-dlp` executable.
- Optional runtime/CORS settings: `PORT` and comma-separated `ALLOWED_ORIGINS`.

### Deploying to Vercel

Set the required account and AI variables in the Vercel project settings for
each target environment. Add `YOUTUBE_API_KEY` if playlist metadata lookup is
needed. Do not put provider or Supabase secrets in frontend variables such as
`NEXT_PUBLIC_*` or `VITE_*`. Apply the Supabase migration and configure the
Supabase Email provider and allowed redirect URLs above, then run the
repository's checks (`npm test`) and deploy through the normal Vercel workflow.
This repository's Vercel configuration uses platform auto-detection; the app
runtime is Node.js 24. After deployment, check `/api/health` for provider
readiness. A successful health check does not replace an authenticated,
end-to-end learning-flow test.

PDF extraction reads selectable text; scanned image-only PDFs are not OCRed.
Video explanations and question citations require usable transcript segments.
When transcript or PDF text is unavailable, the app should report that
limitation rather than claim source-grounded content.

## 📈 Mastery Logic
The app uses an evidence-based update system. Mastery is not a simple percentage but a weighted score:
- **Correct Answer**: Increases mastery significantly.
- **Correct with Hint**: Increases mastery slightly.
- **Incorrect Answer**: Decreases mastery and flags the concept as a "weakness" if errors persist.

---
Developed by **Vinayak4243** as part of a Bachelor's degree project.
