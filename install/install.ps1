$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ExpectedNodeVersion = "v24.18.0"
$ExtensionId = "0xfunboy.vspilink"
$NodeDownloadBase = "https://nodejs.org/dist/v24.18.0"

function Stop-Install([string]$Message) {
    throw "VSPiLink installer: $Message"
}

function Find-Vsix {
    if ($env:VSPILINK_VSIX) {
        if (-not (Test-Path -LiteralPath $env:VSPILINK_VSIX -PathType Leaf)) {
            Stop-Install "VSPILINK_VSIX does not point to a file."
        }
        return (Resolve-Path -LiteralPath $env:VSPILINK_VSIX).Path
    }

    $sourceRoot = Split-Path -Parent $PSScriptRoot
    $candidates = @(
        @(
            Get-ChildItem -LiteralPath $PSScriptRoot -Filter "vspilink-*.vsix" -File -ErrorAction SilentlyContinue
            Get-ChildItem -LiteralPath (Join-Path $sourceRoot "release") -Filter "vspilink-*.vsix" -File -ErrorAction SilentlyContinue
        ) | Select-Object -ExpandProperty FullName -Unique
    )

    if ($candidates.Count -ne 1) {
        Stop-Install "expected exactly one bundled release\vspilink-<version>.vsix; found $($candidates.Count)."
    }
    return $candidates[0]
}

function Find-NodeCli {
    $managedNode = Join-Path $env:LOCALAPPDATA "VSPiLink\node-v24.18.0\node.exe"
    if (Test-Path -LiteralPath $managedNode -PathType Leaf) {
        return $managedNode
    }

    $command = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) {
        return $command.Source
    }
    return $null
}

function Install-ManagedNode {
    if ($env:VSPILINK_SKIP_NODE_BOOTSTRAP -eq "1") {
        Stop-Install "exact Node.js is unavailable and managed runtime bootstrap was disabled with VSPILINK_SKIP_NODE_BOOTSTRAP=1."
    }

    $architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    switch ($architecture) {
        "X64" {
            $nodePlatform = "win-x64"
            $expectedArchiveSha = "0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821"
        }
        "Arm64" {
            $nodePlatform = "win-arm64"
            $expectedArchiveSha = "f274669adb93b1fd0fbf8f21fd078609e9dcc84333d4f2718d2dde3f9a161a01"
        }
        default {
            Stop-Install "automatic Node.js bootstrap does not support Windows/$architecture."
        }
    }

    $archiveName = "node-v24.18.0-$nodePlatform.zip"
    $sourceUrl = "$NodeDownloadBase/$archiveName"
    $temporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("vspilink-node-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null

    try {
        $archivePath = Join-Path $temporaryDirectory $archiveName
        Write-Host "Downloading verified Node.js runtime from $sourceUrl"
        Invoke-WebRequest -UseBasicParsing -Uri $sourceUrl -OutFile $archivePath
        $actualArchiveSha = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualArchiveSha -ne $expectedArchiveSha) {
            Stop-Install "downloaded Node.js archive failed pinned SHA-256 verification."
        }

        Expand-Archive -LiteralPath $archivePath -DestinationPath $temporaryDirectory
        $extractedDirectory = Join-Path $temporaryDirectory "node-v24.18.0-$nodePlatform"
        $extractedNode = Join-Path $extractedDirectory "node.exe"
        if (-not (Test-Path -LiteralPath $extractedNode -PathType Leaf)) {
            Stop-Install "verified Node.js archive has an unexpected layout."
        }
        $extractedVersion = (& $extractedNode --version 2>$null | Select-Object -First 1).Trim()
        if ($extractedVersion -ne $ExpectedNodeVersion) {
            Stop-Install "verified archive did not contain Node.js $ExpectedNodeVersion."
        }

        $managedParent = Join-Path $env:LOCALAPPDATA "VSPiLink"
        $managedRoot = Join-Path $managedParent "node-v24.18.0"
        New-Item -ItemType Directory -Path $managedParent -Force | Out-Null
        if (Test-Path -LiteralPath $managedRoot) {
            $backupPath = "$managedRoot.backup.$(Get-Date -Format 'yyyyMMddHHmmss').$([guid]::NewGuid().ToString('N'))"
            Move-Item -LiteralPath $managedRoot -Destination $backupPath
            Write-Host "Preserved the previous managed runtime at $backupPath"
        }
        Move-Item -LiteralPath $extractedDirectory -Destination $managedRoot
        $managedNode = Join-Path $managedRoot "node.exe"
        $installedVersion = (& $managedNode --version 2>$null | Select-Object -First 1).Trim()
        if ($installedVersion -ne $ExpectedNodeVersion) {
            Stop-Install "managed Node.js verification failed after installation."
        }
        Write-Host "Installed verified Node.js $installedVersion at $managedNode"
        return $managedNode
    }
    finally {
        if (Test-Path -LiteralPath $temporaryDirectory) {
            Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force
        }
    }
}

function Find-CodeCli {
    if ($env:VSCODE_CLI) {
        if (-not (Test-Path -LiteralPath $env:VSCODE_CLI -PathType Leaf)) {
            Stop-Install "VSCODE_CLI does not point to a file."
        }
        return (Resolve-Path -LiteralPath $env:VSCODE_CLI).Path
    }

    foreach ($name in @("code.cmd", "code-insiders.cmd", "code.exe", "code-insiders.exe")) {
        $command = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($command) {
            return $command.Source
        }
    }

    $commonPaths = @(
        (Join-Path $env:LOCALAPPDATA "Programs\Microsoft VS Code\bin\code.cmd"),
        (Join-Path $env:LOCALAPPDATA "Programs\Microsoft VS Code Insiders\bin\code-insiders.cmd"),
        (Join-Path $env:ProgramFiles "Microsoft VS Code\bin\code.cmd")
    )
    foreach ($path in $commonPaths) {
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            return $path
        }
    }
    return $null
}

function Confirm-Checksum([string]$Target) {
    $checksumFile = Join-Path (Split-Path -Parent $Target) "SHA256SUMS"
    if (-not (Test-Path -LiteralPath $checksumFile -PathType Leaf)) {
        if ($env:VSPILINK_ALLOW_UNVERIFIED_DEVELOPMENT_INSTALL -eq "1") {
            Write-Warning "SHA256SUMS is missing. Continuing only because VSPILINK_ALLOW_UNVERIFIED_DEVELOPMENT_INSTALL=1. Use this override only for a local development VSIX that you built and reviewed yourself."
            return
        }
        Stop-Install "SHA256SUMS is required beside the VSIX. Refusing an unverified install. For a local development build only, set VSPILINK_ALLOW_UNVERIFIED_DEVELOPMENT_INSTALL=1."
    }

    $filename = Split-Path -Leaf $Target
    $matches = @()
    foreach ($line in Get-Content -LiteralPath $checksumFile) {
        if ($line -match '^([0-9a-fA-F]{64})\s+\*?(.+)$' -and $Matches[2] -eq $filename) {
            $matches += $Matches[1].ToLowerInvariant()
        }
    }
    if ($matches.Count -ne 1) {
        Stop-Install "SHA256SUMS must contain exactly one entry for $filename."
    }

    $actual = (Get-FileHash -LiteralPath $Target -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $matches[0]) {
        Stop-Install "checksum verification failed for $filename."
    }
    Write-Host "Checksum verified: $filename"
}

$nodeCli = Find-NodeCli
$actualNodeVersion = ""
if ($nodeCli) {
    $actualNodeVersion = (& $nodeCli --version 2>$null | Select-Object -First 1).Trim()
}
if ($actualNodeVersion -ne $ExpectedNodeVersion) {
    if ($nodeCli) {
        Write-Host "Found $actualNodeVersion at $nodeCli; VSPiLink requires $ExpectedNodeVersion exactly. Installing a verified per-user runtime."
    }
    else {
        Write-Host "Node.js $ExpectedNodeVersion was not found. Installing a verified per-user runtime."
    }
    $nodeCli = Install-ManagedNode
    $actualNodeVersion = (& $nodeCli --version 2>$null | Select-Object -First 1).Trim()
}
if ($actualNodeVersion -ne $ExpectedNodeVersion) {
    Stop-Install "Node.js exact-version verification failed."
}
Write-Host "Node.js verified: $actualNodeVersion"

$vsix = Find-Vsix
$vsixName = Split-Path -Leaf $vsix
if ($vsixName -notmatch '^vspilink-([0-9]+\.[0-9]+\.[0-9]+(?:[-.][0-9A-Za-z.-]+)?)\.vsix$') {
    Stop-Install "cannot determine a safe version from $vsixName."
}
$extensionVersion = $Matches[1]

Confirm-Checksum -Target $vsix

$codeCli = Find-CodeCli
if (-not $codeCli) {
    Stop-Install "VS Code CLI was not found. In VS Code press Ctrl+Shift+P, run 'Shell Command: Install code command in PATH' when available, then run this installer again."
}
Write-Host "VS Code CLI: $codeCli"

if ($env:SSH_CONNECTION -or $env:SSH_TTY) {
    Write-Host "Remote-SSH detected. When this script runs in the VS Code remote integrated terminal, the CLI should install VSPiLink into that remote extension host."
    Write-Host 'After installation, open Extensions and verify VSPiLink says "Installed on SSH: <host>". If it appears only under Local, use the extension gear menu and choose "Install in SSH: <host>".'
}

& $codeCli --install-extension $vsix --force | Out-Null
if ($LASTEXITCODE -ne 0) {
    Stop-Install "VS Code rejected the VSIX installation."
}

$installed = @(& $codeCli --list-extensions --show-versions 2>$null)
$expectedListing = "$ExtensionId@$extensionVersion"
if (-not ($installed | Where-Object { $_ -ieq $expectedListing })) {
    Stop-Install "installation returned success, but $expectedListing was not reported by the selected VS Code CLI."
}

Write-Host "Installed and verified: $expectedListing"
Write-Host 'Final required click: return to VS Code, press Ctrl+Shift+P, select "Developer: Reload Window", and press Enter.'
Write-Host 'With Remote-SSH, reload the remote VS Code window and re-check that VSPiLink is installed on the SSH host.'
