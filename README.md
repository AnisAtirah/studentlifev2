# 🌿 StudentLife

A pixel-art study companion for university students: tasks, course link folders, a calendar with exam countdowns, a Pomodoro timer with a study pet that levels up, and Spotify controls.

Built with **React + Vite**, **Firebase** (Google sign-in + Firestore), and hosted on **Vercel**.

## Features
- **Sign in** with Google, or try it as a guest (guests get sample data)
- **Dashboard**: tasks with priorities, "Due Soon" warnings, next deadline, next exam, course progress
- **Weekly Planner** (AI agent): say *"I have a DB quiz Friday and an OS assignment due Monday"*. It reads your tasks, courses and calendar, splits the work into study sessions across the week, saves them as tasks, and gives each one XP. You can reply to adjust the plan or undo it.
- **Daily quest board** (AI agent, no chat): when you open the app, it looks at what's due or overdue and pins up to 3 quests for today, e.g. *"⚔️ Finish ERD draft (+50 XP)"*. Clearing a quest pays bonus XP on top of the task, and clearing the board pays bonus coins.
- **Task breakdown** (AI agent): *"Break down my final year proposal"*, or press **Break into steps** on a task. It adds 5 or 6 steps under the task, each with a time estimate, a date and XP.
- **Review my notes** (AI agent): *"Quiz me on my OS week 3 slides"*, or press **Review** on a link in a course folder. It opens the notes, slides and past papers saved in your courses, then summarises, explains or quizzes you. The planner and the task breakdown read them too, so study sessions name the real topics. Google files need sharing set to "Anyone with the link can view"; Drive folders can't be opened.
- **Chat history**: the Planner page has a **History** tab with your last 30 chats. Open one to read it again, or carry on where you left off. Only the text you saw is saved, so a chat takes a few KB.
- **My Course**: a folder per course for past year papers, notes and lecture Drive links
- **Calendar**: exams, classes (weekly repeats), meetings, task due dates, live exam countdowns
- **Focus**: Pomodoro timer (25/5 or 50/10) with an animated pet (cat, dog or turtle) that studies, sips coffee and naps with you
  - Floating mini timer, plus a pop-out window that stays on top of other apps (Chrome/Edge)
  - The pet cheers you on with motivation, fun facts and break tips
  - XP, coins, daily streaks and a Wardrobe of hats, glasses and desk items
  - Goal sticky notes, 8-bit sounds, and Spotify Premium controls

## Run it on your computer (localhost)

### 1. Install Node.js
Install **Node.js LTS** from https://nodejs.org. Check it worked:
```
node -v
npm -v
```

> **Windows: `npm.ps1 cannot be loaded because running scripts is disabled`**
> Run this once in PowerShell, then reopen the terminal:
> ```
> Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
> ```
> Or type `npm.cmd` instead of `npm` (e.g. `npm.cmd run dev`).
>
> **`npm` not recognized right after installing Node?** Close VS Code completely and open it again.

### 2. Get the code and install packages
```
git clone https://github.com/AnisAtirah/StudentLife.git
cd StudentLife
npm install
```

### 3. (Optional) Turn on Spotify
Skip this if you don't need music controls; the rest of the app works without it. Playback control needs **Spotify Premium**.

1. Create an app at https://developer.spotify.com/dashboard (choose **Web API**).
2. Add this **Redirect URI** exactly:
   ```
   http://127.0.0.1:5173/spotify-callback.html
   ```
3. Copy `.env.example` to a new file named **`.env.local`** and paste in your Client ID:
   ```
   VITE_SPOTIFY_CLIENT_ID=your-client-id
   ```
   `.env.local` is private and is never committed.

### 4. (Optional) Turn on the AI agents
The planner, quest board, task breakdown and notes review are AI agents. They run on **Gemini** (free tier) or **Claude**. Skip this if you don't need them.

**Gemini (free):**
1. Create a key at https://aistudio.google.com/apikey.
2. Add it to `.env.local`:
   ```
   GEMINI_API_KEY=your-key
   ```

**Claude:** create a key at https://platform.claude.com/, set a monthly spend limit, and add `ANTHROPIC_API_KEY=sk-ant-...` instead.

If both keys are set, Gemini is used. Add `AI_PROVIDER=anthropic` to switch to Claude. Pick the Gemini model in the **AI model** menu on the Planner page (default Gemini 3.7 Flash). The choice is saved on that device and the quest board uses it too. The list lives in `src/agents/models.js`, and the server only accepts models from that list. `GEMINI_MODEL` sets the model used when none is picked, and `CLAUDE_MODEL` sets the Claude model (default `claude-opus-5-5`). When Gemini answers "high demand", the server waits and tries again, and a new chat moves to `GEMINI_FALLBACK_MODEL` (default `gemini-3.6-flash`). Restart `npm run dev` after editing `.env.local`.

The keys have no `VITE_` prefix, so they stay on the server and never reach the browser. `npm run dev` serves `api/agent.js` locally, so you don't need the Vercel CLI.

### 5. Set up Firebase
Follow [Firebase setup](#firebase-setup) below and put your Firebase config in `.env.local`. Sign-in and saving won't work without it.

### 6. Start the app
```
npm run dev
```
Open **http://localhost:5173** in **Chrome or Edge**.

- The terminal may show `http://127.0.0.1:5173`. That's fine: the app moves you to `localhost` automatically, because Firebase sign-in only allows `localhost`.
- Stop the server with `Ctrl + C`.

## Firebase setup
The Firebase keys are **not** in the code. Each person puts their own in `.env.local`, which is never committed. Do this before step 5 above.

### 1. Create a Firebase project
1. Go to the [Firebase console](https://console.firebase.google.com) and click **Add project** (or **Create a project**).
2. Give it a name (e.g. `studentlife`) and finish the wizard. Google Analytics is optional.

### 2. Register a web app and copy its config
1. In the project, click the **</>** (Web) icon on the overview page, or go to **⚙️ Project settings → General → Your apps → Add app → Web**.
2. Give it a nickname and click **Register app**. You don't need Firebase Hosting.
3. Firebase shows a `firebaseConfig` object like this (you can see it again any time in **Project settings → General → Your apps → SDK setup and configuration → Config**):
   ```js
   const firebaseConfig = {
     apiKey: "AIza...",
     authDomain: "your-project-id.firebaseapp.com",
     projectId: "your-project-id",
     storageBucket: "your-project-id.firebasestorage.app",
     messagingSenderId: "123456789012",
     appId: "1:123456789012:web:abc123...",
     measurementId: "G-XXXXXXXXXX"
   };
   ```

### 3. Put the config in `.env.local`
Copy `.env.example` to `.env.local` (if you haven't already) and fill in each value from that object:
```
VITE_FIREBASE_API_KEY=AIza...
VITE_FIREBASE_AUTH_DOMAIN=your-project-id.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your-project-id
VITE_FIREBASE_STORAGE_BUCKET=your-project-id.firebasestorage.app
VITE_FIREBASE_MESSAGING_SENDER_ID=123456789012
VITE_FIREBASE_APP_ID=1:123456789012:web:abc123...
VITE_FIREBASE_MEASUREMENT_ID=G-XXXXXXXXXX
```
`src/firebase.js` reads these in the browser, and `api/_auth.js` uses the API key and project ID to check logins for the AI agents. `measurementId` only matters if you turned on Analytics; leave it empty otherwise. Restart `npm run dev` after editing `.env.local`.

### 4. Turn on sign-in
1. **Build → Authentication → Get started**.
2. **Sign-in method**: enable **Google** (pick a support email) and **Anonymous** (Anonymous is used for guest mode).
3. **Settings → Authorized domains**: `localhost` is there by default. Add your Vercel domain (e.g. `your-app.vercel.app`) for the live site.

### 5. Create the database and publish the rules
1. **Build → Firestore Database → Create database**. Pick a location close to you (e.g. `asia-southeast1`) and start in **production mode**.
2. Open the **Rules** tab, replace everything with the contents of `firestore.rules` from this repo, and click **Publish**.

### 6. Add the keys to Vercel (live site)
In **Vercel → Project → Settings → Environment Variables**, add the same seven `VITE_FIREBASE_*` variables with the same values, then **redeploy**. `VITE_` variables are baked in at build time, so a redeploy is needed after any change.

> **Is the Firebase API key secret?** Not really: a Firebase web API key only identifies your project and ends up in the browser bundle anyway. Your data is protected by `firestore.rules` and Authentication, not by hiding the key. We still keep it out of the repo so every developer uses their own project, and it's good practice to restrict the key in **Google Cloud console → APIs & Services → Credentials** to your domains (`localhost`, your Vercel domain).

## Troubleshooting
| Problem | Fix |
|---|---|
| `Port 5173 is in use` | Another `npm run dev` is still running. Close that terminal and try again. The port is fixed to 5173 because Spotify needs the exact address. |
| Google sign-in: `auth/unauthorized-domain` | Use `http://localhost:5173`. For the live site, add its domain in Firebase → Authorized domains. |
| "This sign-in method is not turned on" | Enable Google / Anonymous in Firebase Authentication. |
| "Couldn't load your data" | Create the Firestore database and publish `firestore.rules`. |
| `Firebase is not configured` in the console, or `auth/invalid-api-key` | Fill in the `VITE_FIREBASE_*` values in `.env.local` (or Vercel env vars) and restart `npm run dev` / redeploy. |
| Pop-out timer does nothing | Open the app in a normal Chrome/Edge tab, not inside VS Code's built-in browser. |
| Spotify: "Invalid redirect URI" | The redirect URI in the Spotify dashboard must match step 3 exactly. |
| Spotify: "Open Spotify on your laptop or phone…" | Open the Spotify app and play any song once, then try again. |
| No sound | Check the 🔊 button on the Focus page. Browsers only allow sound after you click something on the page. |

## Other commands
```
npm run build     # production build into dist/
npm run preview   # serve the production build locally
```

## Deploying (Vercel)
Vercel builds automatically when `main` is pushed (`vercel.json` uses the Vite preset). For Spotify on the live site:
- Add `VITE_SPOTIFY_CLIENT_ID` in **Vercel → Project → Settings → Environment Variables**, then redeploy.
- Add `https://<your-vercel-domain>/spotify-callback.html` as a Redirect URI in the Spotify dashboard.

For the AI agents, add `GEMINI_API_KEY` (or `ANTHROPIC_API_KEY`) in the same place, plus `GEMINI_MODEL` / `AI_PROVIDER` if you use them. Don't add a `VITE_` prefix. `api/agent.js` is deployed as a serverless function.

### How the AI agents work
All four agents share one loop (`src/agents/runAgent.js`) that runs in the browser. Each turn goes to `/api/agent` with the agent's name. The server checks the student's Firebase ID token and forwards the conversation to Claude with that agent's prompt and tools from `src/agents/specs.js`. The browser never sends a prompt of its own, so the route can't be used as a general Claude proxy. When Claude asks for a tool, the browser runs it against Firestore with the student's own login, so the security rules in `firestore.rules` still apply. Each agent can only run the tools its spec lists.

| Agent | Started by | Tools | Writes |
|---|---|---|---|
| Weekly planner | a chat message | list_courses, list_tasks, list_calendar, read_course_link, create_tasks | study sessions and deadlines with XP |
| Quest board | opening the app, once a day | list_tasks, list_calendar, set_daily_quests | `dailyQuests` on the profile |
| Task breakdown | a chat message or **Break into steps** | list_tasks, list_courses, read_course_link, create_subtask (called once per step) | steps with `parentId` and `estMinutes` |
| Notes review | a chat message or **Review** on a course link | list_courses, read_course_link | nothing (read-only) |

Tool inputs are checked in `src/agents/tools.js` before anything is saved. Course codes and task ids must exist, dates can't be in the past or after the deadline, XP must stay in range, and duplicates are rejected. A failed check goes back to Claude as an error, so it fixes the input and tries again.

**Reading course links.** `read_course_link` sends only a course id and link id to `/api/link`. The server looks the URL up in the student's own course document (through the Firestore REST API, signed in as them), so it can't be used to fetch arbitrary sites. It rewrites Google Docs, Slides, Sheets and Drive file links to their export addresses, blocks private network addresses, follows at most 4 redirects, and stops at 15 MB. Text comes back in parts of about 30,000 characters; PDFs are converted to text with `unpdf`.

## Project structure
```
src/
  App.jsx            sign-in flow: login → character select → app
  MainApp.jsx        sidebar, banner, Home + Add Task, wires all pages together
  db.js              Firestore reads/writes and guest sample data
  CoursesPage.jsx    course folders and links
  CalendarPage.jsx   calendar, agenda, exam countdowns
  FocusPage.jsx      Pomodoro, pet, goals board
  PlannerPage.jsx    Planner page: the three agent chats and chat history
  QuestBoard.jsx     daily quest board on Home
  agents/specs.js    each agent's prompt, tools and effort (shared with the server)
  agents/tools.js    the code behind each tool, with input checks (runs in the browser)
  agents/runAgent.js the agent loop, the API call, and the no-chat quest run
  petSprites.js      pixel-art pets (drawn on a 28×28 canvas)
  petGear.js         Wardrobe items
  petTalk.js         the pet's motivation lines, fun facts and tips
  rewards.js         XP, levels and streaks
  spotify.js         Spotify login (PKCE) and playback controls
  sounds.jsx         8-bit sound effects
api/agent.js         Vercel function: checks the login and calls Gemini or Claude
api/_gemini.js       translates the agent conversation to and from the Gemini API
api/link.js          Vercel function: opens a saved course link and returns its text
api/_readLink.js     link fetching, Google export links, HTML/PDF to text
api/_auth.js         Firebase login check and Firestore reads as the student
firestore.rules      Firestore security rules
public/              images and the Spotify login return page
```
