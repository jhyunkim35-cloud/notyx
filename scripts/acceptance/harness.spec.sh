# 하네스 자체 (회귀로 잃지 않게)
assert_file scripts/verify.sh "verify.sh 존재"
assert_file scripts/acceptance.sh "acceptance.sh 존재"
assert_file .githooks/pre-commit "프리커밋 훅 존재"
assert_file .github/workflows/verify.yml "GitHub Actions CI 워크플로 존재"
# 44b321d에서 CLAUDE.md를 볼트 정본 포인터로 의도적으로 줄였다. 그때 사라진
# "행동 규약" 문자열을 계속 요구하느라 이 스펙이 CI를 빨갛게 잡고 있었다.
# 지금 CLAUDE.md가 실제로 보장해야 하는 것은 "볼트 정본을 먼저 읽으라"는 지시다.
assert_contains CLAUDE.md "반드시 읽을 것" "CLAUDE.md 볼트 정본 포인터 유지"
