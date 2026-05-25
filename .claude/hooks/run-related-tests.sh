#!/bin/bash
# PostToolUse hook: 编辑 server/ 文件后自动运行对应测试
data=$(cat)
fp=$(echo "$data" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('file_path',''))")

# 只处理 server/ 下的 JS 文件
if [[ "$fp" != *"/server/"* ]] || [[ "$fp" != *.js ]]; then
  exit 0
fi

name=$(basename "${fp%.js}")
test_file=$(find . -maxdepth 5 -name "${name}.test.js" 2>/dev/null | grep -v node_modules | head -1)

if [ -n "$test_file" ]; then
  echo "🧪 自动运行相关测试: $test_file"
  ./node_modules/.bin/vitest run "$test_file" --reporter=verbose 2>&1 | tail -25
fi
exit 0
