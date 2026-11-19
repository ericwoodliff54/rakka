"""Emails the audit report. Needs the SMTP_USER and SMTP_PASSWORD secrets (a Google Workspace app password).
Usage: python3 send_report.py [crashed]"""
import os, sys, smtplib, json
from email.message import EmailMessage

user, pw = os.environ.get('SMTP_USER', ''), os.environ.get('SMTP_PASSWORD', '')
to = os.environ.get('REPORT_TO', 'contact@twinravensdigital.com')
if not user or not pw:
    print('Email secrets are not set; skipping the email. The report is still in the run summary.')
    sys.exit(0)
msg = EmailMessage()
msg['From'] = f'RAKKA Audit <{user}>'
msg['To'] = to
if len(sys.argv) > 1 and sys.argv[1] == 'crashed':
    run = f"https://github.com/{os.environ.get('GITHUB_REPOSITORY','')}/actions/runs/{os.environ.get('GITHUB_RUN_ID','')}"
    msg['Subject'] = 'RAKKA recall audit: the audit itself FAILED to run'
    msg.set_content(f'The weekly recall audit crashed before it could finish. Open the run to see why:\n{run}\n')
else:
    level = json.load(open('audit_result.json')).get('level', 'Review')
    msg['Subject'] = f'RAKKA recall audit: {level}'
    msg.set_content(open('audit_report.txt').read())
    msg.add_alternative(open('audit_report.html').read(), subtype='html')
with smtplib.SMTP_SSL('smtp.gmail.com', 465) as s:
    s.login(user, pw)
    s.send_message(msg)
print('Report emailed to', to)
