# REQUIREMENTS.md

## Project
- **Name:** DestekBot
- **One-line purpose:** Customer-support chatbot for a Turkish e-commerce company.
- **Type:** AI agent/LLM app
- **Users / audience:** public Turkish consumers

## Functional requirements
- R1: Answer customer questions using the FAQ in faq.md.
- R2: Look up order status by order number via the internal orders API.
- R3: The bot must never execute arbitrary commands or code.
- R4: Conversation logs are stored only in anonymized form (no names, phone numbers, or T.C. kimlik numbers).
- R5: Customers are told their messages are processed by an AI provider abroad before the chat starts.

## Non-functional requirements
- N1: Each conversation is capped at 10 model calls.
