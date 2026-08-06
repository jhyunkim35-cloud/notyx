# Landing feature-claim audit — 2026-08-06

Scope: `public/index.html` `#landingView` (L4476–4663), the logged-out screen.

Verdict criterion is **not** "does code exist" but **"can a logged-in user actually
reach this behaviour"**. A module with globals and zero call sites is a data layer,
not a feature.

Baseline commit: `460095c`. Freeze decision of record: vault
`_Notyx 출시 할일.md` L11 — **③ 새로움 동결: 게이미피케이션·스터디룸/그룹·시간표·Notion연동
→ P1·P2까지 비활성/뒤로.**

Legend — **OK** reachable and accurately worded · **과장** reachable but the copy
promises more than the code does · **미도달** no entry point, or entry point exists
but the promised behaviour does not.

---

## Summary

| # | Section | Claim | Verdict |
|---|---|---|---|
| 1 | hero | PPT + 녹음 → 시험 중심 노트 | OK |
| 2 | hero | 자료와 녹음을 함께 읽고 교수 강조 중심 | OK |
| 3 | hero note | 가격·사용량 한도 미고지 | **미고지 게이트** |
| 4 | preview | "강의 중 2회 강조" | 과장 (범위 밖 — 기록만) |
| 5 | inputs | .pptx · .pdf · .docx | OK |
| 6 | inputs | 필기·슬라이드 사진 여러 장 순서대로 | **과장** |
| 7 | inputs | 강의 녹음 (브라우저 녹음 / 오디오 업로드) | OK |
| 8 | inputs | 녹취록 텍스트 붙여넣기 | OK |
| 9 | inputs | 노션 페이지 (.md · .zip) | 과장 (경미) |
| 10 | features 01 | 지시어 해석 | OK |
| 11 | features 02 | 발화자 번호 + "반복해서 강조한 지점" | **과장** |
| 12 | features 03 | 분할 뷰 + 근거 슬라이드 점프 | OK |
| 13 | features 04 | 퀴즈 생성 + 채점 | OK |
| 14 | features 05 | SRS 복습 | **과장** (전제 미고지) |
| 15 | more | 시험 계획 | OK |
| 16 | more | **시간표** | **미도달** |
| 17 | more | **스터디 룸 "함께 보기"** | **미도달** (약속한 동작이 없음) |
| 18 | more | 녹취록 보관 → 다시 노트로 | OK |
| 19 | more | 폴더로 과목별 정리 | OK |

**제거 대상 2건 · 문구 축소 5건 · 신규 고지 1건.**

---

## 미도달

### 16. 시간표 — L4644 「시간표에 강의를 올려두고 노트와 이어 보기」

`public/js/timetable.js`는 전역 5개를 노출하고 **호출부가 레포 전체에 0건**이다
(실측: `grep -rn` on `public/`).

| 전역 | 정의 | 호출 |
|---|---|---|
| `newTimetableEntry` | `timetable.js:78` | 0 |
| `saveTimetableEntry` | `timetable.js:93` | 0 |
| `getTimetableEntry` | `timetable.js:107` | 0 (`:118`은 자기 로그) |
| `listTimetableEntries` | `timetable.js:124` | 0 (`:140`은 자기 로그) |
| `deleteTimetableEntry` | `timetable.js:147` | 0 |

사이드바(`index.html:4380–4392`)에 항목이 없고, `id="*View"` 5개 중에도 없다.
버튼·메뉴·뷰 전환 어느 것도 없으므로 **데이터 계층만 있는 상태.**
6/28 동결 대상과도 정면 충돌.

> 주의: `index.html:4854` 「＋ 교시 추가」(`addSessionBtn`)는 시간표가 아니라
> 다중 노트 배치 모드의 슬라이드↔녹취록 짝짓기 UI다(`batch.js:132`). 혼동 금지.

**처방: 랜딩에서 줄 삭제.** `timetable.js`는 그대로 둔다(자산).

### 17. 스터디 룸 — L4645 「스터디 룸에서 같은 수업 듣는 사람들과 **함께 보기**」

진입은 된다 — 사이드바 `openStudyRoomEntryModal()` (`index.html:4383` →
`study_rooms.js:179`), 백엔드 `api/room-create.js`·`api/room-join.js` 실재,
2026-07-16 라이브 눈검 완료(볼트 타임라인).

**문제는 도달이 아니라 약속한 동작이 존재하지 않는다는 것.**
`study_rooms.js:1–7`이 기능의 프라이버시 계약을 명시한다:

```
// Same-lecture peers share study time + progress only. Note CONTENT is
// never surfaced here; the only fields rendered from members docs are:
//   displayName, photoURL, joinedAt, studyMinutes, notesCount,
//   progressPct, lastActiveAt
// — the privacy contract of the feature.
```

모달 자체도 사용자에게 이렇게 말한다 (`study_rooms.js:188`):
> 「같은 강의를 듣는 친구들과 학습 시간·진도만 공유해요. **노트 내용은 비공개로 유지됩니다.**」

랜딩의 "함께 보기"는 노트 공유 열람으로 읽히고, 제품은 **정확히 그 반대를 계약으로
보장**한다. 문구 축소로는 안 된다 — "학습 시간·진도만 공유"로 줄이면 이번엔 6/28
동결 대상을 그대로 광고하는 게 된다.

**처방: 랜딩에서 줄 삭제.** 동결 결정을 따른다. 코드·사이드바 진입점은 유지.

---

## 미고지 게이트

### 3. 무료 한도 — 랜딩 전체에 가격·한도 언급 0건

`payment.js:229–232`:

```js
async function canAnalyze() {
  if (DEVELOPER_EMAILS.includes(currentUser?.email)) return { allowed: true, reason: '' };
  const usage = await getUserUsage();
  if (usage.plan === 'monthly') return { allowed: true, reason: '' };
  if (usage.monthlyCount < 3) return { allowed: true, reason: '', remaining: 3 - usage.monthlyCount };
  return { allowed: false, reason: 'monthly_limit', monthlyCount: usage.monthlyCount };
}
```

**무료 = 월 3회 분석.** 4회째부터 결제 모달(`showPaymentModal`)에 막힌다.
호출부 3곳: `note_creation.js:6`, `main_inline.js:633`, `:675`.
요금은 월정액 7,900원 / 1회권 500원 (`payment.js:174`).

랜딩은 hero note에서 「Google 계정으로 바로 시작 · 설치 없이 브라우저에서」라고만 하고
한도를 말하지 않는다. 판정 기준 ③에 정확히 걸린다.

**처방(안): hero note를 「Google 계정으로 바로 시작 · 매달 3개 노트까지 무료」로.**
가격 섹션 신설은 새 주장 추가가 아니라 이미 걸려 있는 게이트의 고지이므로 C에서
다룰 수 있다 — 다만 준현 승인 필요 항목으로 올린다.

---

## 과장 — 문구 축소

### 6. 필기·슬라이드 사진 — L4573 「여러 장을 한 번에 올려도 **순서대로 이어서** 읽습니다.」

두 군데가 어긋난다.

**① 정렬을 안 한다.** `pptx_parser.js:60` — `imageFiles = list;`
`list`는 `Array.from(FileList)`(`:42`)이고 **정렬 코드가 없다.** 파일 선택 순서는
브라우저가 정한다. 같은 파일에서 녹취록 슬롯은 `sortRecSlotsByName()`으로 자연순
정렬을 명시적으로 하는데(`:141–142`), 이미지 경로에는 그 대응물이 없다.

**② 30장 상한.** `MAX_IMAGE_UPLOAD_COUNT = 30` (`constants.js:136`),
초과 시 `pptx_parser.js:51–54`에서 거부.

**③ (더 큰 문제) 자료 슬롯은 배타적이다.** `pptx_parser.js:92`
`imageFiles = []; // mutual exclusion: a deck/doc replaces any staged images`
`note_creation.js:107` 도 `else if (imageFiles.length)` 로 분기한다.
**PPT와 필기 사진을 같이 넣을 수 없다.** 랜딩은 5개 입력을 병렬 카드로 늘어놓아
조합 가능한 것처럼 읽힌다.

**처방:** "순서대로 이어서" 삭제 → 「사진 여러 장(최대 30장)을 한 번에 올릴 수 있습니다.」
+ INPUT 섹션에 자료 슬롯 배타성 한 줄 명시. (배타성 고지는 새 주장이 아니라 기존 주장의 정정)

### 11. features 02 — L4609 「…**반복해서 강조한** 지점을 노트에 남깁니다.」

앞 절반(발화자 번호 지정 → 교수 발화 분리)은 **OK**:
설정 UI `index.html:4348` `#professorNum` → `note_creation.js:134–135` →
`separateSpeakers()` `pptx_parser.js:1102`. Clova `참석자 N:` / AssemblyAI
`발화자 N:` 두 포맷 매칭(`:1128–1129`).

뒤 절반이 과장. 제품은 **반복 횟수를 세지 않는다.** 프롬프트가 정의하는 동작은
"명시적 강조 표현이 있을 때만 ⭐" 하나다:

- `pipeline.js:281` `⭐ 교수님 강조사항 (명시적 강조 시에만)`
- `pipeline.js:328` `- ⭐는 교수님이 명시적으로 강조한 경우만`
- `pipeline.js:1694` 강조 표현의 정의 = "이게 중요해", "시험에 나와", "꼭 기억해" 등 **어구**

(`:532` 시험 요약층 프롬프트에만 "강조·반복한 부분"이 나오지만, 이것도 LLM 판단이지
반복 검출 로직이 아니다.)

**처방:** 「…교수님 발화를 따로 읽고, **강조한 지점을 노트에 표시합니다.**」

### 14. features 05 — L4629–4630 SRS 복습

동작 자체는 실재한다(`srs.js`, `srs_review.js`). 문제는 **진입점이 단 하나이고 조건부**라는 것.

`home_view.js:31`:
```js
if (folder.examPlan && typeof getDueCards === 'function') {
```
→ `:34` `getDueCards(...)` → `:35` `if (!dueCards.length) return;` → `:38` 배지 렌더 →
`:42–45` 클릭 시 `enterReviewMode(folder.id)`.

`enterReviewMode` 호출부는 레포 전체에 **이 한 곳뿐**(`srs_review.js:327` 정의,
`:535` export). 사이드바에도 홈에도 독립 진입점이 없다.

즉 **①폴더를 만들고 ②그 폴더에 시험 계획을 등록하고 ③due 카드가 생겨야** 비로소
"오늘 복습 N개" 배지가 나타난다. 랜딩은 이걸 독립 기능처럼 약속한다.

**처방:** 「**시험 계획을 등록한 과목은** 복습 간격을 계산해서, 오늘 봐야 할 것만
골라 보여줍니다.」 — 15번(시험 계획)과 인과로 묶으면 리듬도 산다.

### 9. 노션 페이지 — L4585 (경미)

배선은 완전하다: `index.html:4817` `accept=".md,.zip"` →
`main_inline.js:938–1000` change/click 핸들러 → `parseNotionFile` → `saveNoteFS`.

다만 산출물이 다른 입력과 다르다. `main_inline.js:970` `type: 'notion'` 으로 저장되고
`openNotionNote()`(`notion_viewer.js`)로 열린다 — Agent 파이프라인을 타지 않는다.
섹션 UI 자체가 「노션에서 바로 **퀴즈**」(`index.html:4811`)라고 말한다.
랜딩은 이걸 다른 4개 입력과 같은 줄에 세워 같은 학습 노트가 나오는 것처럼 읽히게 한다.

**처방:** 「마크다운(.md · .zip)으로 내보낸 페이지에서 **바로 퀴즈를 만듭니다.**」

> 6/28 동결의 "Notion연동"은 API 연동을 뜻한다. 이건 파일 임포트라 동결 대상이 아니다 — 유지.

### 4. preview 노트 예시 — L4537 「…— 강의 중 **2회** 강조」 (범위 밖)

11번과 같은 뿌리. 제품은 강조를 ⭐로 표시할 뿐 **횟수를 출력하지 않는다.**
골에서 `#ny-preview` 교체를 범위 밖으로 지정했으므로 **이번 라운드에서 고치지 않는다.**
진짜 노트로 교체할 때 같이 처리할 것.

---

## OK — 근거

| # | claim | 근거 |
|---|---|---|
| 1·2 | hero | 아래 5·7·10·11의 합 |
| 5 | .pptx·.pdf·.docx | `index.html:4779` accept · `pptx_parser.js:81` 검증 · `:403` 분기 · `:414` `extractDocxText` |
| 7 | 브라우저 녹음 / 오디오 업로드 | `index.html:4832` `#recordBtn` 「녹음 / 오디오 업로드」 · `recorder.js` · `api/assemblyai.js`·`whisper-stt.js` |
| 8 | 녹취록 붙여넣기 | `index.html:4833` `#pasteMemoBtn` |
| 10 | 지시어 해석 | `pipeline.js:56–77` agent1 앞 단계. `detectDeixisCandidates` 게이트 + fail-open(`:75`). PPT·녹취록 **둘 다** 필요(`:61`) — 문구가 "같이 읽습니다"라 전제 일치 |
| 12 | 분할 뷰 + 점프 | `viewers.js:148` `jumpToSlide` · `:99–101`·`:212–222` R7 `p.N` 인용 칩이 `data-slide-start/-end` 보유 · `main_inline.js:326` `#splitViewBtn` |
| 13 | 퀴즈 + 채점 | `quiz.js:316` 객관식/단답/서술형 · `:523`·`:670`·`:790–804` API 채점 · `:893` 서술형 평균. **"채점까지 합니다"의 범위 = 서술형 포함 — 과장 아님** |
| 15 | 시험 계획 | `exam_plan.js:326` `openExamPlanModal` · `index.html:4705` `#folderExamPlanBtn` · `examDate`/`prepStartDate`/`dailyTarget`(`:18–20`)이 SRS 스케줄러를 구동 |
| 18 | 녹취록 보관 → 재노트 | 사이드바 `switchView('transcripts')`(`index.html:4382`) · `transcripts_view.js:111`·`:159`·`:356` 「새 노트 만들기」 → `:308` `switchView('new')` · `:435` U18 역참조 칩 |
| 19 | 폴더 | `folders.js` · 사이드바 폴더 섹션(`index.html:4395`) · `index.html:4714` 폴더 관리 |

---

## G1 — 준현 확인 필요

**삭제 2줄** (미도달 · 동결 결정 준수)
- L4644 시간표
- L4645 스터디 룸

**문구 축소 4곳**
- L4573 이미지 "순서대로 이어서" → 장수 상한 + 슬롯 배타성
- L4585 노션 → "바로 퀴즈"
- L4609 "반복해서 강조한" → "강조한"
- L4630 SRS → "시험 계획을 등록한 과목은" 전제 명시

**신규 고지 1건 (승인 필요)**
- 무료 월 3회 한도 — hero note 한 줄 수정 또는 가격 섹션

**G2 — 배선만 하면 도달 가능 (이번 범위 밖, 보고만)**
- **시간표**: `timetable.js`는 CRUD 5개가 완비돼 있고 뷰·사이드바 항목만 없다.
  화면 하나 + 사이드바 버튼 하나면 도달 가능해진다. **단 6/28 동결 대상이므로
  배선 자체가 동결 결정 번복이다 — 기능 추가 이전에 결정 사안.**
- **SRS 독립 진입점**: `getTotalDueCount`가 이미 export돼 있는데(`srs_review.js:539`)
  호출부가 0건이다. 사이드바에 전체 due 배지 하나면 시험 계획 없이도 복습에 도달한다.
  현재는 랜딩 문구를 좁히는 쪽으로 처방했으나, 배선을 택하면 문구를 그대로 둘 수 있다.
