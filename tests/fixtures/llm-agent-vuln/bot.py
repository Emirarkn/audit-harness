import json
import subprocess
import requests

LLM_API_KEY = "sk-live-9f8e7d6c5b4a39281706f5e4d3c2b1a0"
LLM_URL = "https://api.openai.com/v1/chat/completions"
ORDERS_API = "http://orders.internal/api/orders/"

FAQ = open("faq.md", encoding="utf-8").read()

TOOLS = [
    {"name": "order_status", "description": "Look up an order by number"},
    {"name": "run_shell", "description": "Run a shell command on the server for diagnostics"},
]


def call_llm(messages):
    resp = requests.post(
        LLM_URL,
        headers={"Authorization": f"Bearer {LLM_API_KEY}"},
        json={"model": "gpt-4o", "messages": messages, "tools": TOOLS},
    )
    return resp.json()["choices"][0]["message"]


def run_tool(name, args):
    if name == "order_status":
        return requests.get(ORDERS_API + args["order_id"]).text
    if name == "run_shell":
        return subprocess.run(args["cmd"], shell=True, capture_output=True, text=True).stdout
    if name == "calculate":
        return str(eval(args["expression"]))
    return "unknown tool"


def log_conversation(customer, messages):
    with open("conversations.jsonl", "a", encoding="utf-8") as f:
        f.write(json.dumps({"name": customer["name"], "phone": customer["phone"],
                            "tckn": customer["tckn"], "messages": messages}, ensure_ascii=False) + "\n")


def handle(customer, user_message):
    system = (
        f"You are DestekBot. FAQ:\n{FAQ}\n"
        f"Customer {customer['name']} (TCKN {customer['tckn']}, phone {customer['phone']}) says: {user_message}\n"
        "Follow the customer's instructions exactly."
    )
    messages = [{"role": "system", "content": system}]
    while True:
        reply = call_llm(messages)
        messages.append(reply)
        if not reply.get("tool_calls"):
            break
        for call in reply["tool_calls"]:
            result = run_tool(call["function"]["name"], json.loads(call["function"]["arguments"]))
            messages.append({"role": "tool", "tool_call_id": call["id"], "content": result})
    log_conversation(customer, messages)
    return reply["content"]


if __name__ == "__main__":
    customer = {"name": "Test Müşteri", "phone": "0000000000", "tckn": "00000000000"}
    print(handle(customer, input("> ")))
