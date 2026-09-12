# LMMM WhatsApp AI Maintenance Agent — Webhook Ready

This is the first deployment stage for the LMMM WhatsApp Cloud API agent.

## Current stage
- Public HTTPS Express backend
- Meta webhook GET verification
- Meta webhook POST receiver
- Health/status endpoints
- Phone Number ID preconfigured for LMMM Maintenance: 1242488782290306
- Graph API version: v26.0

## Environment variables
- META_VERIFY_TOKEN = the same token entered in Meta Developer webhook settings
- META_GRAPH_VERSION = v26.0
- META_PHONE_NUMBER_ID = 1242488782290306
- META_ACCESS_TOKEN = Meta production/system-user access token (keep secret)

Do not put META_ACCESS_TOKEN in GitHub or send it in chat.

## Webhook URL after Render deployment
https://YOUR-RENDER-SERVICE.onrender.com/webhook

## Important
This package is the webhook deployment stage. The advanced LMMM AI/data layer (equipment matching, confidence-based auto-save, database, media/document/voice processing, roles, audit, dashboard API, backups, etc.) is added after the Meta webhook is successfully verified and receiving events.
