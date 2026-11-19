import csv
import requests
from bs4 import BeautifulSoup

BASE = "https://jobs.example.com/listings?page={}"
HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36"}


def get_total_pages():
    html = requests.get(BASE.format(1), headers=HEADERS).text
    soup = BeautifulSoup(html, "html.parser")
    return int(soup.select_one(".pagination .last").text)


def parse_page(html):
    soup = BeautifulSoup(html, "html.parser")
    rows = []
    for card in soup.select(".job-card"):
        rows.append({
            "title": card.select_one(".title").text.strip(),
            "company": card.select_one(".company").text.strip(),
            "city": card.select_one(".city").text.strip(),
            "recruiter_name": card.select_one(".recruiter").text.strip(),
            "recruiter_email": card.select_one(".recruiter-email").text.strip(),
            "recruiter_phone": card.select_one(".recruiter-phone").text.strip(),
        })
    return rows


def main():
    all_rows = []
    total = get_total_pages()
    for page in range(1, total):
        try:
            html = requests.get(BASE.format(page), headers=HEADERS).text
            all_rows.extend(parse_page(html))
        except Exception:
            pass
    with open("jobs.csv", "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=all_rows[0].keys())
        writer.writeheader()
        writer.writerows(all_rows)


if __name__ == "__main__":
    main()
