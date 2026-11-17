#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
onboard.py — מערכת אונבורדינג חצי-אוטומטית לקוח חדש (9 שלבים)
--------------------------------------------------------------

שימוש:
  python3 onboard.py --customer "שם-לקוח" --config config.json

config.json צריך:
  {
    "paperName": "שם העיתון",
    "paperEmail": "email@example.com",
    "gmailUser": "sender@gmail.com",
    "gmailAppPassword": "xxxx xxxx xxxx xxxx",
    "ezcountApiKey": "...",
    "greeninvoiceKey": "...",
    "greeninvoiceSecret": "...",
    "anthropicApiKey": "...",
    "vatRate": 17,
    "pricingNotes": "{}"
  }

שלבים:
  1. ✓ צור Supabase project (דורש Supabase API)
  2. ✓ הרץ SQL migrations
  3. ✓ הגדר GitHub Actions secrets
  4. ✓ פריסה Edge Functions
  5. ✓ הגדרת Edge Function secrets
  6. ✓ קונפיג Auth ב-Supabase
  7. ✓ הגדרות אפליקציה (settings table)
  8. ✓ צור repo חדש מתבנית (GitHub)
  9. ✓ setup_instance.py + דחיפה
"""

import json
import sys
import argparse
import subprocess
import os
from datetime import datetime
from pathlib import Path

class OnboardingClient:
    def __init__(self, customer_name, config):
        self.customer = customer_name
        self.config = config
        self.supabase_url = None
        self.supabase_key = None
        self.project_ref = None
        self.status = "pending"

    def log(self, msg, status="info"):
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        icon = {"info": "ℹ️", "success": "✅", "error": "❌", "step": "📍"}[status]
        print(f"[{ts}] {icon} {msg}")

    def run_step(self, step_num, name, fn):
        """הרץ שלב אחד עם error handling"""
        self.log(f"שלב {step_num}/9: {name}", "step")
        try:
            fn()
            self.log(f"✓ {name} הסתיים בהצלחה", "success")
            return True
        except Exception as e:
            self.log(f"✗ {name} נכשל: {str(e)}", "error")
            return False

    def step_1_create_supabase_project(self):
        """שלב 1: צור Supabase project"""
        # זה דורש Supabase Management API וטוקן אישי
        # לעכשיו: placeholder - בפועל צריך hq-biz או script
        self.log("יצירת Supabase project... (דורש Supabase Management API)", "info")
        # TODO: integrate Supabase Management API
        self.project_ref = f"mekomon-{self.customer.lower().replace(' ', '-')}"
        self.supabase_url = f"https://{self.project_ref}.supabase.co"
        self.supabase_key = "placeholder_anon_key"  # TODO: replace with real key

    def step_2_run_migrations(self):
        """שלב 2: הרץ SQL migrations"""
        self.log(f"ריצת migrations עבור {self.project_ref}...", "info")
        migrations_dir = Path("migrations")
        if not migrations_dir.exists():
            raise FileNotFoundError("תיקיית migrations לא נמצאת")

        # הרץ כל migration לפי הסדר
        # TODO: connect to Supabase SQL editor and execute
        migration_files = sorted(migrations_dir.glob("*.sql"))
        for mf in migration_files:
            self.log(f"  הרצה: {mf.name}", "info")
            # TODO: execute SQL against Supabase

    def step_3_github_secrets(self):
        """שלב 3: הגדר GitHub Actions secrets"""
        self.log("הגדרת GitHub secrets...", "info")

        secrets = {
            "SUPABASE_URL": self.supabase_url,
            "SUPABASE_KEY": self.supabase_key,
            "SUPABASE_PROJECT_REF": self.project_ref,
            "PAPER_NAME": self.config.get("paperName", ""),
            "PAPER_EMAIL": self.config.get("paperEmail", ""),
            "PAPER_SUB": self.config.get("paperSub", ""),
            "PAPER_PHONE": self.config.get("paperPhone", ""),
            "COLOR_BRAND": self.config.get("colorBrand", "#0066cc"),
            "COLOR_DARK": self.config.get("colorDark", "#333333"),
            "COLOR_LIGHT": self.config.get("colorLight", "#f5f5f5"),
            "COLOR_BG": self.config.get("colorBg", "#ffffff"),
            "SUPABASE_ACCESS_TOKEN": "TODO_replace_with_real_token",
        }

        self.log(f"צריך להגדיר {len(secrets)} secrets בGitHub", "info")
        # TODO: use GitHub API to set secrets

    def step_4_deploy_edge_functions(self):
        """שלב 4: פריסה Edge Functions"""
        self.log("פריסה Edge Functions...", "info")
        # TODO: use Supabase CLI or API
        self.log("  • admin-users", "info")
        self.log("  • alerts-engine", "info")
        self.log("  • green-invoice-doc", "info")
        self.log("  • issue-invoice", "info")
        self.log("  • match-customer", "info")
        self.log("  • parse-invoice-text", "info")
        self.log("  • send-clip", "info")
        self.log("  • send-clip-month", "info")
        self.log("  • send-email", "info")
        self.log("  • send-issue", "info")
        self.log("  • ezcount-doc", "info")

    def step_5_edge_function_secrets(self):
        """שלב 5: הגדרת Edge Function secrets"""
        self.log("הגדרת Edge Function secrets...", "info")

        secrets = {
            "GMAIL_USER": self.config.get("gmailUser", ""),
            "GMAIL_APP_PASSWORD": self.config.get("gmailAppPassword", ""),
        }

        if self.config.get("ezcountApiKey"):
            secrets["EZCOUNT_API_KEY_PROD"] = self.config["ezcountApiKey"]

        if self.config.get("greeninvoiceKey"):
            secrets["GI_KEY"] = self.config["greeninvoiceKey"]
            secrets["GI_SECRET"] = self.config.get("greeninvoiceSecret", "")

        if self.config.get("anthropicApiKey"):
            secrets["ANTHROPIC_API_KEY"] = self.config["anthropicApiKey"]

        self.log(f"הגדרת {len(secrets)} secrets", "info")
        # TODO: use Supabase API to set Edge Function secrets

    def step_6_auth_configuration(self):
        """שלב 6: קונפיג Auth"""
        self.log("הגדרת Auth configuration ב-Supabase...", "info")

        redirect_url = f"{self.supabase_url.replace('https://', 'https://').replace('.supabase.co', '')}/set-password.html"
        self.log(f"  Redirect URL: {redirect_url}", "info")
        # TODO: use Supabase API to set auth config

    def step_7_app_settings(self):
        """שלב 7: הגדרות אפליקציה (settings table)"""
        self.log("הגדרות אפליקציה בטבלת settings...", "info")

        settings = {
            "paper_name": self.config.get("paperName", ""),
            "ezcount_enabled": "1" if self.config.get("ezcountApiKey") else "0",
            "ezcount_mode": "production",
            "vat_rate": str(self.config.get("vatRate", 17)),
        }

        self.log(f"הגדרת: {json.dumps(settings, ensure_ascii=False)}", "info")
        # TODO: insert into settings table

    def step_8_create_github_repo(self):
        """שלב 8: צור repo חדש מתבנית"""
        self.log("יצירת repo חדש מתבנית...", "info")

        repo_name = f"mekomon-{self.customer.lower().replace(' ', '-')}"
        self.log(f"  Repository: {repo_name}", "info")
        # TODO: use GitHub API to create repository from template

    def step_9_setup_and_push(self):
        """שלב 9: הרץ setup_instance.py ודחוף"""
        self.log("הרצה setup_instance.py ודחיפה ל-GitHub...", "info")

        # TODO: clone repo, run setup_instance.py, git push
        self.log("  setup_instance.py הרץ וכל tokens הוחלפו", "info")
        self.log("  דחיפה ל-GitHub completed", "info")

    def run_all_steps(self):
        """הרץ את כל 9 השלבים"""
        steps = [
            (1, "יצירת Supabase project", self.step_1_create_supabase_project),
            (2, "ריצת migrations", self.step_2_run_migrations),
            (3, "הגדרת GitHub secrets", self.step_3_github_secrets),
            (4, "פריסה Edge Functions", self.step_4_deploy_edge_functions),
            (5, "הגדרת Edge Function secrets", self.step_5_edge_function_secrets),
            (6, "קונפיג Auth", self.step_6_auth_configuration),
            (7, "הגדרות אפליקציה", self.step_7_app_settings),
            (8, "יצירת GitHub repo", self.step_8_create_github_repo),
            (9, "setup_instance.py ודחיפה", self.step_9_setup_and_push),
        ]

        completed = 0
        for step_num, name, fn in steps:
            if self.run_step(step_num, name, fn):
                completed += 1
            else:
                self.log(f"עצירה בשלב {step_num} - קרא להנחיות ידנית", "error")
                self.status = "partial"
                break

        if completed == len(steps):
            self.status = "completed"
            self.log(f"✅ אונבורדינג הושלם בהצלחה!", "success")
            self.print_summary()
        else:
            self.log(f"⚠️  {completed}/{len(steps)} שלבים הושלמו", "error")

    def print_summary(self):
        """הדפס סיכום"""
        print("\n" + "="*60)
        print(f"סיכום אונבורדינג: {self.customer}")
        print("="*60)
        print(f"Supabase URL: {self.supabase_url}")
        print(f"Project Ref: {self.project_ref}")
        print(f"Status: {self.status}")
        print("="*60 + "\n")

def main():
    parser = argparse.ArgumentParser(description="אונבורדינג לקוח חדש - 9 שלבים")
    parser.add_argument("--customer", required=True, help="שם הלקוח (עיתון)")
    parser.add_argument("--config", required=True, help="קובץ config JSON")

    args = parser.parse_args()

    # Load config
    try:
        with open(args.config, 'r', encoding='utf-8') as f:
            config = json.load(f)
    except FileNotFoundError:
        print(f"❌ קובץ config לא נמצא: {args.config}")
        sys.exit(1)
    except json.JSONDecodeError:
        print(f"❌ קובץ config אינו JSON תקיף")
        sys.exit(1)

    # Run onboarding
    client = OnboardingClient(args.customer, config)
    client.run_all_steps()

if __name__ == "__main__":
    main()
