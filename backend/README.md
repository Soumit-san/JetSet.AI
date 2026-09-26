---
title: JetSet AI Backend
emoji: ✈️
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
license: mit
---  

# JetSet.AI — Backend API Orchestration Engine (Hugging Face Space) ✈️

This repository contains the containerized production NestJS backend configuration for **JetSet.AI**. It acts as the central orchestration API server managing trip data caching, RAG (Retrieval-Augmented Generation) databases, SerpAPI searches, and dual-LLM parallel routing.

---

## ⚙️ Hugging Face Configuration

* **SDK:** Docker (Multi-stage Node.js alpine build)
* **App Port:** `7860` (Exposed container endpoint)

---

## 🔒 Required Environment Variables (Space Secrets & Variables)

For the backend to execute properly, configure the following under your Hugging Face Space **Settings > Variables and secrets**:

### Secrets (Space Secrets)
| Secret Key | Description |
| :--- | :--- |
| `DATABASE_URL` | Supabase PostgreSQL connection string with pgvector |
| `GROQ_API_KEY` | Groq API Key (Primary LLM & Tuffy Copilot stream) |
| `OPENROUTER_API_KEY` | OpenRouter API Key (RAG Embeddings & Fallback LLM) |
| `SERPAPI_KEY_FLIGHTS` | SerpAPI Key for live Google Flights pricing |
| `SERPAPI_KEY_HOTELS` | SerpAPI Key for live Google Hotels data |
| `GEOAPIFY_API_KEY` | Geoapify Key for location autocomplete & geocoding |
| `JWT_SECRET` | Secret key for booking confirmation challenges (optional, defaults provided) |

### Variables (Non-Secret Space Variables)
| Variable Key | Value / Description |
| :--- | :--- |
| `OPENROUTER_MODEL` | `openrouter/free` |
| `OPENROUTER_EMBEDDING_MODEL` | `openai/text-embedding-3-small` |
| `OPENROUTER_FREE_ONLY` | `true` |
| `PORT` | `7860` |
| `NODE_ENV` | `production` |

---

## 🚀 Deployment Instructions

Hugging Face Spaces compiles and runs the container automatically:
1. Create a new Space on Hugging Face.
2. Choose **Docker** as the SDK (with Blank template).
3. Upload the contents of the `backend/` directory (including the `Dockerfile`, `.dockerignore`, `package.json`, and this `README.md`) directly to the Space repository.
4. Go to **Settings > Variables and secrets** in your Space, and add the credentials listed in the table above.
5. Hugging Face will automatically trigger the Docker build, map port `7860`, and boot the NestJS API application.
