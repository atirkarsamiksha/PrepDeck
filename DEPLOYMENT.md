# PrepDeck Production Deployment Guide

This guide provides instructions for deploying PrepDeck to production with MongoDB Atlas, persistent document storage, and environment security.

---

## 1. MongoDB Atlas Setup (Production Database)

1. **Create Cluster**:
   - Go to [MongoDB Atlas](https://www.mongodb.com/cloud/atlas) and create a free or dedicated cluster (M0 or higher).
2. **Database User**:
   - In **Database Access**, create a user (e.g. `prepdeck_admin`) with `readWriteAnyDatabase` privileges.
3. **Network Access**:
   - In **Network Access**, add IP Address `0.0.0.0/0` (Allow access from anywhere) or whitelist your hosting provider's IP range.
4. **Connection String**:
   - Under Clusters > **Connect** > **Drivers** > **Node.js**, copy the connection string:
     ```
     mongodb+srv://<username>:<password>@cluster0.xxxxx.mongodb.net/prepdeck?retryWrites=true&w=majority
     ```

---

## 2. Environment Variables Checklist

Configure these environment variables in your hosting provider's dashboard:

| Variable | Description | Example / Recommendation |
| :--- | :--- | :--- |
| `NODE_ENV` | Environment mode | `production` |
| `PORT` | HTTP port | `5000` (or platform default like `10000`) |
| `MONGODB_URI` | MongoDB Atlas URI | `mongodb+srv://<user>:<pw>@cluster.mongodb.net/prepdeck` |
| `JWT_SECRET` | Secret for signing tokens | High-entropy string (min 32 characters) |
| `GEMINI_API_KEY`| Google Gemini API key | Active Gemini API key with flash model access |
| `CORS_ORIGIN` | Allowed domains | Comma-separated or `*` (e.g. `https://prepdeck.onrender.com`) |
| `STORAGE_PATH` | PDF storage directory | Path to persistent disk mount (e.g. `/opt/render/project/src/server/uploads`) |

---

## 3. Deploying to Render (Recommended for Persistent Storage)

Render is recommended because it supports persistent disks, ensuring uploaded PDFs are never lost between deploys.

### Option A: Using `render.yaml` Blueprint
1. Push your repository to GitHub.
2. In the Render Dashboard, click **New +** > **Blueprint**.
3. Connect your GitHub repository.
4. Render will detect `render.yaml` and configure:
   - Web Service running `node server.js`
   - Persistent Disk (5 GB) mounted at `/opt/render/project/src/server/uploads`
   - Health check path `/api/health`
5. Supply `MONGODB_URI` and `GEMINI_API_KEY` when prompted in the dashboard.
6. Click **Apply**.

### Option B: Manual Web Service Setup
1. In Render, select **New Web Service**.
2. Settings:
   - **Root Directory**: `server`
   - **Build Command**: `npm install --production`
   - **Start Command**: `node server.js`
   - **Health Check Path**: `/api/health`
3. Under **Disks**, add a disk:
   - **Name**: `prepdeck-uploads`
   - **Mount Path**: `/opt/render/project/src/server/uploads`
   - **Size**: 5 GB
4. Under **Environment Variables**, add the checklist variables above, setting `STORAGE_PATH` to `/opt/render/project/src/server/uploads`.

---

## 4. Deploying with Docker / Railway

PrepDeck includes a production multi-stage `Dockerfile`.

1. **Railway**:
   - Click **New Project** > **Deploy from GitHub repo**.
   - Under Settings > **Volumes**, add a volume mounted to `/app/server/uploads`.
   - Set environment variables (`MONGODB_URI`, `JWT_SECRET`, `GEMINI_API_KEY`, `STORAGE_PATH=/app/server/uploads`).
   - Railway will build and run the Dockerfile automatically.

2. **Self-Hosted Docker**:
   ```bash
   docker build -t prepdeck:latest .
   docker run -d \
     -p 5000:5000 \
     -v prepdeck_uploads:/app/server/uploads \
     -e MONGODB_URI="mongodb+srv://..." \
     -e JWT_SECRET="your_secret" \
     -e GEMINI_API_KEY="your_gemini_key" \
     -e NODE_ENV="production" \
     --name prepdeck_app prepdeck:latest
   ```

---

## 5. Security & Verification Post-Deployment

Once deployed, verify your deployment:

1. **Health Check**:
   - Access `https://your-domain.com/api/health` — it should return:
     ```json
     {
       "status": "ok",
       "database": "connected",
       "geminiConfigured": true
     }
     ```
2. **Private File Verification**:
   - Try to directly access `https://your-domain.com/uploads/sample.pdf` without authentication — verify it returns **404 Not Found**.
3. **Multi-Tenant Privacy**:
   - Register User A and User B.
   - Verify User B cannot access User A's uploaded documents, notes, or quiz attempts.
