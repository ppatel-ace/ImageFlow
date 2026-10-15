# Google Drive → SharePoint photo copy

Copies the old ImageFlow photos from the Google Drive **ACE** folder into the
`jobtravelerphotos` SharePoint library and checks every file in. Runs on a Windows PC;
no admin rights, no server changes.

| Google Drive (read-only)              | SharePoint                                  |
|---------------------------------------|---------------------------------------------|
| `ACE/{Customer}/{QC|Testing|Production}/{WO}/photo.jpg` | `{Dept}/{Customer}/{WO}/photo.jpg` |
| anything else (e.g. `NSWC/photo.jpg`) | `Old Photos/<Drive path>/photo.jpg`         |

Customer folders match existing SharePoint folders ignoring case and punctuation
(`TELEDYNE FLIR DEFENSE, INC.` → `TELEDYNE FLIR DEFENSE, INC`). `&amp;` folder names are
renamed to `&`. Google Drive is never changed.

## Run it

Double-click **`Copy-Drive-To-SharePoint.cmd`**.

1. First run only: it downloads portable Node + rclone into
   `%LOCALAPPDATA%\AceDriveToSharePoint` and opens the browser. Sign in with the Google
   account that has **ACE** under *Shared with me* and click **Allow** (read-only).
2. It lists Drive, matches SharePoint folders and prints a **plan** (counts, file types,
   new customer folders, renames, anything held back). The full plan is saved as a CSV.
3. Type `y` to start. A progress bar shows files, MB, speed, ETA, new / already there /
   held back / failed.
4. Close the window or press Ctrl+C any time — run it again and it continues where it
   stopped. Files already in SharePoint are skipped (and checked in if they were left
   checked out).

Reports (plan, failed, held back) go to `%LOCALAPPDATA%\AceDriveToSharePoint\reports`.

### Options (PowerShell: `.\Copy-Drive-To-SharePoint.ps1 <options>`)

| Option | What it does |
|--------|--------------|
| `--dry-run` | Plan only, copy nothing |
| `--only "SAIC"` | One customer folder (good for a test) |
| `--skip "A,B"` | Top-level Drive folders to ignore (default `TestCustomer`) |
| `--yes` | Don't ask before copying |
| `--retry-failed` | Try files that failed in an earlier run again |
| `--concurrency 6` | Parallel copies (1–12, default 6) |
| `--folder "<Drive link>"` | Use a different Drive root folder than *Shared with me → ACE* |
| `--reset-google` | Sign in to Google again (e.g. with another account) |

## File fixes it makes

- Text typed after the extension is moved before it so SharePoint previews the photo:
  `x.jpg AK APPROVED` → `x AK APPROVED.jpg`.
- Two Drive files with the same name in one folder: the second becomes `name (2).jpg`.
- HEIC/RAW photos that Drive reports as a generic file type are still copied.
- `desktop.ini`, Google Docs and other non-photos are skipped (listed in the plan).

## Hidden checked-out files

The library requires check-out. A file that someone uploaded but **never checked in**
is invisible to everyone except that person — and it still owns its name, so a new
upload with that name is refused or silently saved as `name (1).jpg`.

On 2026-10-15 the library had **2,759** such files in 119 folders (1,962 under
`Old Photos`, the rest mostly QC/Testing customers T–W) from an earlier manual copy.
The tool detects these folders, **holds their photos back** (no duplicates) and lists
them in `hidden-checkouts-*.csv` / `held-back-*.csv`.

Fix either way, then run the tool again:

- **Automatic (recommended):** give the *Ace JobTravelerPhotos Access* app **Full
  Control** on the `jobtravelerphotos` site (tenant admin, GCC High). The tool then takes
  over and checks in those files itself before copying:

  ```powershell
  Install-Module Microsoft.Graph.Sites -Scope CurrentUser   # once
  Connect-MgGraph -Environment USGov -Scopes Sites.FullControl.All
  $site = "aceelectronics.sharepoint.us,8302eb5d-5510-48db-969d-dc8a13460a5a,90e97411-32c3-4011-a5d9-4219a64ccb20"
  New-MgSitePermission -SiteId $site -BodyParameter @{
    roles = @("fullcontrol")
    grantedToIdentities = @(@{ application = @{ id = "9ae5ad08-419d-41fd-a1ef-b57f014d06ba"; displayName = "Ace JobTravelerPhotos Access" } })
  }
  ```

  This raises what the live ImageFlow app can do on that one site. To go back to Write
  after the migration: `Get-MgSitePermission -SiteId $site` → `Remove-MgSitePermission
  -SiteId $site -PermissionId <id of the fullcontrol grant>`.
- **Manual:** a site owner opens *Documents → Settings → Library settings → Manage files
  which have no checked in version*, selects all, **Take Ownership**, then checks them in
  from the library. Or the person who holds them opens the library and checks them in.
