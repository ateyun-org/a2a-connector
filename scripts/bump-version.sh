#!/usr/bin/env bash
# ==============================================================================
# bump-version.sh - Batch update version across all package.json files
# and plugin manifests in a2a-connector.
# ==============================================================================
set -euo pipefail

# Text colors
if [[ -t 1 ]]; then
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  BLUE='\033[0;34m'
  CYAN='\033[0;36m'
  RED='\033[0;31m'
  BOLD='\033[1m'
  NC='\033[0m'
else
  GREEN=''
  YELLOW=''
  BLUE=''
  CYAN=''
  RED=''
  BOLD=''
  NC=''
fi

# Locate repository root (supports symlinks)
SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"

if [[ -f "$SCRIPT_DIR/package.json" ]]; then
  ROOT_DIR="$SCRIPT_DIR"
elif [[ -f "$SCRIPT_DIR/../package.json" ]]; then
  ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
else
  echo -e "${RED}Error: Cannot locate a2a-connector root directory from $SCRIPT_DIR${NC}" >&2
  exit 1
fi

# Check for node
if ! command -v node >/dev/null 2>&1; then
  echo -e "${RED}Error: 'node' is required to run this script safely.${NC}" >&2
  exit 1
fi

ROOT_PKG="$ROOT_DIR/package.json"
CURRENT_VERSION=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version || "unknown")' "$ROOT_PKG")

bump_calc() {
  local cur="$1"
  local type="$2"
  node -e '
    const [cur, type] = process.argv.slice(1);
    const m = cur.match(/^(\d+)\.(\d+)\.(\d+)(.*)$/);
    if (!m) { console.log(cur); process.exit(0); }
    let [_, maj, min, pat, extra] = m;
    let [M, mNum, pNum] = [Number(maj), Number(min), Number(pat)];
    if (type === "patch") pNum++;
    else if (type === "minor") { mNum++; pNum = 0; }
    else if (type === "major") { M++; mNum = 0; pNum = 0; }
    console.log(`${M}.${mNum}.${pNum}`);
  ' "$cur" "$type"
}

print_help() {
  echo -e "${BOLD}Usage:${NC}"
  echo -e "  $0 <version | patch | minor | major> [options]"
  echo ""
  echo -e "${BOLD}Arguments:${NC}"
  echo -e "  <version>            Specific version to set (e.g. 0.2.2, 1.0.0, 0.3.0-rc.1)"
  echo -e "  patch                Increment patch version: $(bump_calc "$CURRENT_VERSION" patch)"
  echo -e "  minor                Increment minor version: $(bump_calc "$CURRENT_VERSION" minor)"
  echo -e "  major                Increment major version: $(bump_calc "$CURRENT_VERSION" major)"
  echo ""
  echo -e "${BOLD}Options:${NC}"
  echo -e "  -n, --dry-run        Preview changes without modifying any files"
  echo -e "  --packages-only      Only modify package.json files"
  echo -e "  --no-lock            Skip modifying package-lock.json files"
  echo -e "  --no-plugins         Skip modifying plugin manifests (plugin.yaml, connector-meta.json)"
  echo -e "  -h, --help           Show this help message"
  echo ""
  echo -e "${BOLD}Current Version:${NC}"
  echo -e "  ${CYAN}${CURRENT_VERSION}${NC} (from ${ROOT_PKG})"
}

# Parse options
DRY_RUN=false
PACKAGES_ONLY=false
NO_LOCK=false
NO_PLUGINS=false
TARGET_INPUT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      print_help
      exit 0
      ;;
    -n|--dry-run)
      DRY_RUN=true
      shift
      ;;
    --packages-only)
      PACKAGES_ONLY=true
      shift
      ;;
    --no-lock)
      NO_LOCK=true
      shift
      ;;
    --no-plugins)
      NO_PLUGINS=true
      shift
      ;;
    -*)
      echo -e "${RED}Unknown option: $1${NC}" >&2
      print_help
      exit 1
      ;;
    *)
      if [[ -z "$TARGET_INPUT" ]]; then
        TARGET_INPUT="$1"
      else
        echo -e "${RED}Unexpected argument: $1${NC}" >&2
        print_help
        exit 1
      fi
      shift
      ;;
  esac
done

if [[ "$PACKAGES_ONLY" == "true" ]]; then
  NO_LOCK=true
  NO_PLUGINS=true
fi

# If no target specified, prompt if interactive, or show error
if [[ -z "$TARGET_INPUT" ]]; then
  if [[ -t 0 ]]; then
    echo -e "${BOLD}Current root package version:${NC} ${CYAN}${CURRENT_VERSION}${NC}"
    echo -n "Enter new version or bump type (patch/minor/major): "
    read -r TARGET_INPUT
    if [[ -z "$TARGET_INPUT" ]]; then
      echo "No version provided. Exiting."
      exit 0
    fi
  else
    print_help
    exit 1
  fi
fi

# Strip leading 'v'
TARGET_INPUT="${TARGET_INPUT#v}"

# Calculate target version
case "$TARGET_INPUT" in
  patch|minor|major)
    TARGET_VERSION=$(bump_calc "$CURRENT_VERSION" "$TARGET_INPUT")
    ;;
  *)
    TARGET_VERSION="$TARGET_INPUT"
    ;;
esac

# Validate target version format (semver)
if ! [[ "$TARGET_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo -e "${RED}Error: Invalid version format '${TARGET_VERSION}'. Must follow SemVer (e.g. 1.2.3 or 1.2.3-beta.1)${NC}" >&2
  exit 1
fi

echo -e "${BOLD}${BLUE}==> Synchronizing a2a-connector versions: ${YELLOW}${CURRENT_VERSION}${NC} -> ${GREEN}${TARGET_VERSION}${NC}${NC}"
if [[ "$DRY_RUN" == "true" ]]; then
  echo -e "${YELLOW}[DRY RUN MODE - no files will be modified]${NC}"
fi

# Use node to execute updates safely
node - "$ROOT_DIR" "$TARGET_VERSION" "$DRY_RUN" "$NO_LOCK" "$NO_PLUGINS" << 'EOF'
const fs = require('fs');
const path = require('path');

const [rootDir, targetVersion, dryRunStr, noLockStr, noPluginsStr] = process.argv.slice(2);
const dryRun = dryRunStr === 'true';
const noLock = noLockStr === 'true';
const noPlugins = noPluginsStr === 'true';

let modifiedCount = 0;
let unchangedCount = 0;

function rel(filePath) {
  return path.relative(rootDir, filePath) || path.basename(filePath);
}

function findFiles(dir, matchName, results = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findFiles(fullPath, matchName, results);
    } else if (entry.isFile() && entry.name === matchName) {
      results.push(fullPath);
    }
  }
  return results;
}

// 1. package.json files
const pkgFiles = findFiles(rootDir, 'package.json');
console.log('\n\x1b[1m[package.json]\x1b[0m');
for (const file of pkgFiles) {
  const content = fs.readFileSync(file, 'utf8');
  let json;
  try {
    json = JSON.parse(content);
  } catch {
    console.warn(`  \x1b[33m⚠ Skipped (invalid JSON):\x1b[0m ${rel(file)}`);
    continue;
  }

  if (typeof json.version !== 'string') {
    // E.g. vendor/connector/package.json without version
    continue;
  }

  const oldVer = json.version;
  if (oldVer === targetVersion) {
    console.log(`  \x1b[36m• Already ${targetVersion}:\x1b[0m ${rel(file)}`);
    unchangedCount++;
    continue;
  }

  const updated = content.replace(/(^|\n)([ \t]*"version"[ \t]*:[ \t]*")[^"]+(")/, `$1$2${targetVersion}$3`);
  const verify = JSON.parse(updated);
  if (verify.version !== targetVersion) {
    throw new Error(`Failed to update version in ${file}`);
  }

  if (!dryRun) {
    fs.writeFileSync(file, updated, 'utf8');
  }
  console.log(`  \x1b[32m✓\x1b[0m ${rel(file)}: \x1b[33m${oldVer}\x1b[0m -> \x1b[32m${targetVersion}\x1b[0m`);
  modifiedCount++;
}

// 2. package-lock.json files
if (!noLock) {
  const lockFiles = findFiles(rootDir, 'package-lock.json');
  console.log('\n\x1b[1m[package-lock.json]\x1b[0m');
  for (const file of lockFiles) {
    const content = fs.readFileSync(file, 'utf8');
    let lock;
    try {
      lock = JSON.parse(content);
    } catch {
      continue;
    }

    if (typeof lock.version !== 'string') continue;
    const oldVer = lock.version;
    const rootPkgVer = lock.packages?.['']?.version;

    if (oldVer === targetVersion && rootPkgVer === targetVersion) {
      console.log(`  \x1b[36m• Already ${targetVersion}:\x1b[0m ${rel(file)}`);
      unchangedCount++;
      continue;
    }

    lock.version = targetVersion;
    if (lock.packages && lock.packages['']) {
      lock.packages[''].version = targetVersion;
    }

    if (!dryRun) {
      fs.writeFileSync(file, JSON.stringify(lock, null, 2) + '\n', 'utf8');
    }
    console.log(`  \x1b[32m✓\x1b[0m ${rel(file)}: \x1b[33m${oldVer}\x1b[0m -> \x1b[32m${targetVersion}\x1b[0m`);
    modifiedCount++;
  }
}

// 3. Plugin manifests
if (!noPlugins) {
  console.log('\n\x1b[1m[Plugin Manifests]\x1b[0m');

  // Workbuddy connector-meta.json
  const wbMeta = path.join(rootDir, 'plugins', 'workbuddy', 'connector-meta.json');
  if (fs.existsSync(wbMeta)) {
    const content = fs.readFileSync(wbMeta, 'utf8');
    let json = JSON.parse(content);
    if (typeof json.version === 'string') {
      const oldVer = json.version;
      if (oldVer !== targetVersion) {
        const updated = content.replace(/(^|\n)([ \t]*"version"[ \t]*:[ \t]*")[^"]+(")/, `$1$2${targetVersion}$3`);
        if (!dryRun) fs.writeFileSync(wbMeta, updated, 'utf8');
        console.log(`  \x1b[32m✓\x1b[0m ${rel(wbMeta)}: \x1b[33m${oldVer}\x1b[0m -> \x1b[32m${targetVersion}\x1b[0m`);
        modifiedCount++;
      } else {
        console.log(`  \x1b[36m• Already ${targetVersion}:\x1b[0m ${rel(wbMeta)}`);
        unchangedCount++;
      }
    }
  }

  // Hermes plugin.yaml
  const hermesYaml = path.join(rootDir, 'plugins', 'hermes', 'plugin.yaml');
  if (fs.existsSync(hermesYaml)) {
    const content = fs.readFileSync(hermesYaml, 'utf8');
    const match = content.match(/^version:\s*(.+)$/m);
    if (match) {
      const oldVer = match[1].trim();
      if (oldVer !== targetVersion) {
        const updated = content.replace(/(^|\n)([ \t]*version[ \t]*:[ \t]*)[^\r\n]+/, `$1$2${targetVersion}`);
        if (!dryRun) fs.writeFileSync(hermesYaml, updated, 'utf8');
        console.log(`  \x1b[32m✓\x1b[0m ${rel(hermesYaml)}: \x1b[33m${oldVer}\x1b[0m -> \x1b[32m${targetVersion}\x1b[0m`);
        modifiedCount++;
      } else {
        console.log(`  \x1b[36m• Already ${targetVersion}:\x1b[0m ${rel(hermesYaml)}`);
        unchangedCount++;
      }
    }
  }
}

console.log(`\n\x1b[1mSummary:\x1b[0m ${modifiedCount} file(s) updated, ${unchangedCount} file(s) already up to date.`);
EOF

echo ""
if [[ "$DRY_RUN" == "true" ]]; then
  echo -e "${YELLOW}Dry run completed. Run without --dry-run to apply changes.${NC}"
else
  echo -e "${GREEN}${BOLD}✓ Version synchronization complete!${NC}"
fi
