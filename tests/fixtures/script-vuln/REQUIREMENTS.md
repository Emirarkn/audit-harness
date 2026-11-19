# REQUIREMENTS.md

## Project
- **Name:** JobWatch
- **One-line purpose:** Daily scraper that collects public job postings from jobs.example.com.
- **Type:** script/automation
- **Deployment target:** local cron job

## Functional requirements
- R1: Scrape all job listing pages once per day.
- R2: Respect robots.txt and the site's terms of use; identify the bot honestly in the User-Agent.
- R3: Store only job title, company, and city. No personal data.
- R4: Retry a failed page up to 3 times, then report it.
- R5: Write results to jobs.csv.
