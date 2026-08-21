# Served public subscription price and product-copy sweep.

public_files=()
while IFS= read -r file; do public_files+=("$file"); done < <(find public -type f \( -name '*.html' -o -name '*.js' \) -print)

old_price_hits=$(grep -nHE '7,900|₩7,900|7900' "${public_files[@]}" 2>/dev/null || true)
if [ -n "$old_price_hits" ]; then
  _fail "served public files contain an old 7,900 price"
else
  _pass "served public files contain no 7,900 price"
fi

assert_contains public/index.html '8,900' "homepage contains 8,900 recurring price"
assert_contains public/terms.html '8,900원 / 월' "terms contain 8,900 recurring price"
assert_contains public/js/payment.js '₩8,900/월' "payment UI contains 8,900 recurring price"
assert_contains public/index.html '무료 3회' "homepage preserves free-three behavior"
assert_contains public/index.html '1회 500원' "homepage preserves the KRW 500 product"
assert_contains public/terms.html '500원 / 강의' "terms preserve the KRW 500 product"
assert_contains public/terms.html '부가세 포함' "terms disclose VAT inclusion"
assert_contains public/terms.html '자동 갱신' "terms disclose automatic renewal"
assert_contains public/terms.html '현재 이용기간 종료 시 적용' "terms disclose period-end cancellation"
