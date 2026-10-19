// Synthetic conversations shown in the Chrome Web Store screenshots. All content is invented.
// One conversation per listing language; the extension UI follows the browser language.

const CODE = `# analysis/ab_test.py
import csv, math, sys

def two_proportion_z(conv_a, n_a, conv_b, n_b):
    p_a, p_b = conv_a / n_a, conv_b / n_b
    p = (conv_a + conv_b) / (n_a + n_b)
    se = math.sqrt(p * (1 - p) * (1 / n_a + 1 / n_b))
    z = (p_b - p_a) / se
    return p_a, p_b, z, math.erfc(abs(z) / math.sqrt(2))

def load(path):
    counts = {}
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            n, c = counts.get(row["variant"], (0, 0))
            counts[row["variant"]] = (n + 1, c + int(row["signup"]))
    return counts

if __name__ == "__main__":
    counts = load(sys.argv[1])
    (n_a, c_a), (n_b, c_b) = counts["A"], counts["B"]
    p_a, p_b, z, p = two_proportion_z(c_a, n_a, c_b, n_b)
    print(f"A {p_a:.2%}  B {p_b:.2%}  z={z:.2f}  p={p:.4f}")`;

const FIX = 'counts[row["variant"]] = (n + 1, c + int(row["signed_up"]))';

const Z = String.raw`z = \frac{\hat p_B - \hat p_A}{\sqrt{\hat p\,(1-\hat p)\left(\frac{1}{n_A} + \frac{1}{n_B}\right)}} \approx 3.09`;

export const CONVERSATIONS = {
  en: {
    title: 'Pricing page A/B test',
    messages: [
      ['user', 'We ran a two-week A/B test on our pricing page. The goal is to decide which layout to ship by Friday.\n\nControl (A): 12,480 visitors, 374 sign-ups\nVariant B (annual toggle on top): 12,512 visitors, 463 sign-ups\n\nIs B really better?'],
      ['assistant', `Yes — B wins, and the difference is statistically significant.

| Variant | Visitors | Sign-ups | Conversion |
|---|---:|---:|---:|
| A · Control | 12,480 | 374 | 3.00% |
| B · Annual toggle | 12,512 | 463 | **3.70%** |

A two-proportion z-test with the pooled rate \\(\\hat p = 3.35\\%\\):

\\[
${Z}
\\]

That gives **p ≈ 0.002**, so the +23% relative lift is very unlikely to be noise.`],
      ['user', "Great. Let's go with variant B. Never change the Free plan's price, though — legal already approved it. Can you write a script so I can rerun this check on next month's data?"],
      ['assistant', `Sure. Save this as \`analysis/ab_test.py\`:

\`\`\`python
${CODE}
\`\`\`

Run it with \`python analysis/ab_test.py visits.csv\`.`],
      ['user', "Running it on the raw export fails with `KeyError: 'signup'`."],
      ['assistant', `The analytics export names that column \`signed_up\`. Change this line in \`load()\`:

\`\`\`python
${FIX}
\`\`\`

That fixes the KeyError.`],
      ['user', 'That worked — the numbers match. Next, write a short summary for the team and suggest a follow-up test on the annual discount (15% vs 20%).'],
      ['assistant', `**Summary for the team**

Variant B (annual toggle on top) raised sign-up conversion from 3.00% to 3.70% (+23%, p ≈ 0.002) over two weeks with about 25,000 visitors. We'll ship it to everyone on Friday. The Free plan price stays unchanged.

| Next test | Variants | Primary metric |
|---|---|---|
| Annual discount | 15% vs 20% | Paid conversion |

## Next steps

- Ship variant B to 100% of traffic on Friday
- Set up the follow-up test: annual discount 15% vs 20%
- Watch the refund rate for 30 days after launch

The follow-up test is not configured yet. Mobile traffic (n = 2,140) is still too small to tell whether B helps there too.`],
      ['user', 'Okay, draft the follow-up test plan: primary metric, sample size and duration.'],
    ],
  },
  ko: {
    title: '요금제 페이지 A/B 테스트 분석',
    messages: [
      ['user', '요금제 페이지에서 2주 동안 A/B 테스트를 돌렸어요. 금요일까지 어떤 레이아웃을 적용할지 정하는 게 목표예요.\n\nA안(기존): 방문 12,480명, 가입 374명\nB안(연간 결제 토글 상단 배치): 방문 12,512명, 가입 463명\n\nB안이 정말 더 나은 건가요?'],
      ['assistant', `네, B안이 더 낫고 차이도 통계적으로 유의합니다.

| 안 | 방문자 | 가입 | 전환율 |
|---|---:|---:|---:|
| A · 기존 | 12,480 | 374 | 3.00% |
| B · 연간 토글 | 12,512 | 463 | **3.70%** |

합동 전환율 \\(\\hat p = 3.35\\%\\)로 두 비율 z-검정을 하면 다음과 같습니다.

\\[
${Z}
\\]

**p ≈ 0.002**이므로 상대 상승률 23%가 우연일 가능성은 매우 낮습니다.`],
      ['user', 'B안으로 가기로 하자. 단, 무료 요금제 가격은 절대 바꾸지 마세요. 법무팀 승인이 끝난 상태예요. 다음 달 데이터로 다시 검증할 수 있게 스크립트도 만들어 주세요.'],
      ['assistant', `\`analysis/ab_test.py\`로 저장하세요.

\`\`\`python
${CODE}
\`\`\`

\`python analysis/ab_test.py visits.csv\`로 실행합니다.`],
      ['user', "원본 데이터로 돌리니까 `KeyError: 'signup'` 오류가 나요."],
      ['assistant', `분석 도구에서 내보낸 파일은 열 이름이 \`signed_up\`입니다. \`load()\`의 해당 줄을 이렇게 바꾸세요.

\`\`\`python
${FIX}
\`\`\`

이렇게 하면 KeyError가 해결됩니다.`],
      ['user', '해결됐어요. 숫자도 일치해요. 이제 팀 공유용 요약을 써 주고, 연간 할인율(15% vs 20%) 후속 테스트도 제안해 주세요.'],
      ['assistant', `**팀 공유용 요약**

2주간 약 2만 5천 명을 대상으로 테스트한 결과, B안(연간 토글 상단 배치)이 가입 전환율을 3.00%에서 3.70%로 높였습니다(+23%, p ≈ 0.002). 금요일에 전체 사용자에게 적용합니다. 무료 요금제 가격은 바꾸지 않습니다.

| 후속 테스트 | 비교안 | 핵심 지표 |
|---|---|---|
| 연간 할인율 | 15% vs 20% | 유료 전환율 |

## 다음 단계

- 금요일에 B안을 전체 트래픽에 적용
- 후속 테스트 준비: 연간 할인율 15% vs 20%
- 적용 후 30일간 환불률 모니터링

후속 테스트는 아직 설정하지 못했습니다. 모바일 트래픽(n = 2,140)은 표본이 작아 B안 효과를 아직 확인하지 못했습니다.`],
      ['user', '좋아요. 후속 테스트 계획 초안을 써 주세요. 핵심 지표, 표본 크기, 기간을 포함해서요.'],
    ],
  },
};

/** ChatGPT /backend-api/conversation payload (linear tree), as the adapter reads it. */
export function chatgptPayload(lang) {
  const c = CONVERSATIONS[lang];
  const t0 = Date.UTC(2026, 9, 14, 1, 12) / 1000;
  const ids = c.messages.map((_, i) => `msg-${lang}-${i + 1}`);
  const mapping = { root: { id: 'root', parent: null, children: [ids[0]], message: null } };
  c.messages.forEach(([role, text], i) => {
    mapping[ids[i]] = {
      id: ids[i],
      parent: i === 0 ? 'root' : ids[i - 1],
      children: ids[i + 1] ? [ids[i + 1]] : [],
      message: {
        id: ids[i],
        author: { role, name: null },
        create_time: t0 + i * 95,
        content: { content_type: 'text', parts: [text] },
        metadata: role === 'assistant' ? { model_slug: 'gpt-5' } : {},
        recipient: 'all',
        channel: role === 'assistant' ? 'final' : null,
      },
    };
  });
  return { title: c.title, create_time: t0, update_time: t0 + c.messages.length * 95, mapping, current_node: ids[ids.length - 1] };
}
