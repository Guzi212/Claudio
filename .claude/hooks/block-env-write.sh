#!/bin/bash
# PreToolUse hook: 阻止直接写入 .env 文件（含敏感凭证）
data=$(cat)
fp=$(echo "$data" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('file_path',''))")
basename_fp=$(basename "$fp")

if [[ "$basename_fp" == .env* ]] && [[ "$basename_fp" != ".env.example" ]]; then
  echo "❌ 阻止：禁止直接写入 $fp（含敏感凭证）"
  echo "   如需修改 .env，请手动编辑或明确告知我你的意图。"
  exit 1
fi
exit 0
