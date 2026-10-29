#!/bin/bash
# PreToolUse hook: 阻止直接写入 .env 文件（含敏感凭证）
# Claude Code 只把退出码 2 当作拦截，其它非零码只算钩子报错、工具照样执行。
data=$(cat)
fp=$(echo "$data" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('file_path',''))")
fp=${fp//\\//}
basename_fp=$(basename "$fp")

if [[ "$basename_fp" == .env* ]] && [[ "$basename_fp" != ".env.example" ]]; then
  echo "❌ 阻止：禁止直接写入 $fp（含敏感凭证）" >&2
  echo "   如需修改 .env，请手动编辑或明确告知我你的意图。" >&2
  exit 2
fi
exit 0
