@echo off
title RAKKA Community DB - Cloudflare KV Auto Uploader
color 0A
echo =================================================================
echo   RAKKA Community DB - Automated Cloudflare KV Bulk Uploader
echo =================================================================
echo Namespace ID: 13e138ca5e594e778782a18c622b2781
echo.

set /a count=0
for %%f in (rakka_community_seed_part*.json) do (
    set /a count+=1
    echo [%%count%%] Uploading %%f to Cloudflare KV...
    call npx wrangler kv bulk put "%%f" --namespace-id=13e138ca5e594e778782a18c622b2781 --remote
    if errorlevel 1 (
        echo [ERROR] Upload failed for %%f. Pausing...
        pause
    )
    echo.
)

echo =================================================================
echo   SUCCESS! All seed batches uploaded to Cloudflare KV!
echo =================================================================
pause
