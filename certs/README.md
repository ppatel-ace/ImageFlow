# Ace JobTravelerPhotos Access — Azure client certificate

**App:** Ace JobTravelerPhotos Access  
**Client ID:** `9ae5ad08-419d-41fd-a1ef-b57f014d06ba`  
**Tenant (Directory) ID:** `6ab850db-8359-47f8-9e46-ddb57a3f87bd`

This certificate is **different** from the SSO cert (`ace-sso-client.cer` / CN=`sso.aceelectronics.com`).

## Upload `.cer` (Azure GCC High)

1. Open [portal.azure.us](https://portal.azure.us) → **App registrations** → **Ace JobTravelerPhotos Access**
2. **Certificates & secrets** → **Certificates** → **Upload certificate**
3. Select `ace-jobtravelerphotos.cer`
4. Prefer certificate auth (no client secret) when Workload ID Conditional Access requires it

| Property | Value |
|----------|-------|
| Key size | RSA **2048** bit |
| Validity | **730 days** (~2 years), expires **2028-07-14** |
| Subject | `CN=jobtravelerphotos.aceelectronics.com, O=ACE Electronics, C=US` |
| Thumbprint (SHA-1) | `E0FF484B33BD23F04AACD03C8ECDF1B190BB2007` |
| Format | DER `.cer` (public only) |

## Still todo after upload

1. **API permissions (Graph, Application):** `Sites.Selected` (preferred) or `Sites.ReadWrite.All` → **Grant admin consent**
2. **Site access:** grant this app **Write** on `https://aceelectronics.sharepoint.us/sites/jobtravelerphotos` (PnP `Grant-PnPAzureADAppSitePermission` or Graph site permissions)
3. Set ImageFlow env: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, credential (secret or cert), and preferably `SHAREPOINT_SITE_ID`

## Private material (do not upload / do not commit)

| File | Use |
|------|-----|
| `ace-jobtravelerphotos.cer` | Upload to Azure only |
| `ace-jobtravelerphotos.pfx` | Runtime / Portainer (password: `temp-export-only`) |
| `ace-jobtravelerphotos.pem` + `.key` | Alternate file-based cert auth |

PFX password matches the SSO convention (`temp-export-only`) — change if you store it long-term outside this admin machine.
