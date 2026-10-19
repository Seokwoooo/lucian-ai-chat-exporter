// Text on the store images. <hl>…</hl> marks the highlighted phrase of a headline.
// Claims must match the product (README, docs/chrome-web-store-listing.md).

export const COPY = {
  en: {
    s0: {
      eyebrow: 'One-click handoff',
      title: 'Pick up your ChatGPT work <hl>in Claude</hl>',
      steps: ['Click Lucian in ChatGPT', 'Attach the .md file in Claude'],
      claude: {
        greeting: 'Good evening, Jamie',
        prompt: 'Read this handoff and continue where I left off.',
        lines: '{n} lines',
        model: 'Sonnet 5.5',
      },
    },
    s1: {
      eyebrow: 'One-click handoff',
      title: 'Move any AI chat to another AI <hl>in one click</hl>',
      sub: 'A Lucian button appears under every answer on ChatGPT, Claude, Gemini and Grok.',
      callout: 'Under every answer',
    },
    s2: {
      eyebrow: 'Handoff file',
      title: 'The next AI picks up <hl>where you left off</hl>',
      bullets: [
        'Goal, decisions, constraints, open tasks and next steps in one Markdown file',
        'Every line is quoted from the chat and points to its source, like [#m3]',
        'Rule-based, no AI rewriting — nothing is made up',
      ],
    },
    s3: {
      eyebrow: 'Full export',
      title: 'Save the whole chat <hl>as PDF, Word and more</hl>',
      sub: 'Eight formats, built right in your browser.',
      formats: [
        ['md', 'Markdown', '.md'],
        ['pdf', 'PDF', 'Print-ready'],
        ['txt', 'TXT', 'Plain text'],
        ['docx', 'Word', '.docx'],
        ['hwpx', 'Hangul', '.hwpx'],
        ['html', 'HTML', 'Web page'],
        ['json', 'JSON', 'Raw data'],
        ['zip', 'ZIP', 'Full backup'],
      ],
    },
    s4: {
      eyebrow: 'Verified export',
      title: 'Code, tables and math <hl>come through intact</hl>',
      sub: 'Every export is checked — messages, images, attachments and file integrity. Gaps are reported, never hidden.',
      chips: ['Code', 'Tables', 'Math', 'Images', 'Attachments'],
    },
    s5: {
      eyebrow: 'Private by design',
      title: 'Everything stays <hl>in your browser</hl>',
      sub: 'Lucian turns chats into files on your computer. Nothing is sent to us or to any AI service.',
      cards: [
        ['server', 'No servers', 'Your chats are never uploaded.'],
        ['ai', 'No AI APIs', 'Rule-based. No LLM calls.'],
        ['eyeoff', 'No tracking', 'No analytics, no ads.'],
        ['user', 'Zero setup', 'No account, no settings.'],
        ['key', 'Tokens never stored', 'Login data is never saved.'],
        ['bolt', 'Fast', 'A 1M-token chat in about a second.'],
      ],
      sitesLabel: 'Works on',
    },
    small: { tagline: 'AI chat handoff & export' },
    marquee: { headline: 'Hand off and export <hl>your AI chats</hl>' },
  },
  ko: {
    s0: {
      eyebrow: '원클릭 인수인계',
      title: 'ChatGPT에서 하던 일, <hl>Claude에서 이어서</hl>',
      steps: ['ChatGPT에서 Lucian 클릭', 'Claude에 .md 파일 첨부'],
      claude: {
        greeting: '지민 님, 좋은 저녁이에요',
        prompt: '이 인수인계 문서 읽고 이어서 진행해 줘.',
        lines: '{n}줄',
        model: 'Sonnet 5.5',
      },
    },
    s1: {
      eyebrow: '원클릭 인수인계',
      title: 'AI 대화를 <hl>클릭 한 번으로</hl> 다른 AI에 넘기세요',
      sub: 'ChatGPT·Claude·Gemini·Grok의 모든 답변 아래에 Lucian 버튼이 생깁니다.',
      callout: '모든 답변 아래에',
    },
    s2: {
      eyebrow: '인수인계 문서',
      title: '다음 AI가 <hl>하던 작업을 그대로</hl> 이어받습니다',
      bullets: [
        '목표, 확정된 결정, 금지사항, 남은 작업, 다음 할 일을 Markdown 파일 하나에',
        '모든 줄을 대화에서 그대로 발췌하고 [#m3]처럼 출처를 붙입니다',
        'AI가 다시 쓰지 않는 규칙 기반이라 없는 내용을 지어내지 않습니다',
      ],
    },
    s3: {
      eyebrow: '전체 대화 내보내기',
      title: '<hl>PDF·Word·한글</hl>로<br>전체 대화 저장',
      sub: '8가지 형식을 브라우저 안에서 바로 만듭니다.',
      formats: [
        ['md', 'Markdown', '.md'],
        ['pdf', 'PDF', '인쇄용'],
        ['txt', 'TXT', '텍스트'],
        ['docx', 'Word', '.docx'],
        ['hwpx', '한글', '.hwpx'],
        ['html', 'HTML', '웹 페이지'],
        ['json', 'JSON', '원본 데이터'],
        ['zip', 'ZIP', '전체 백업'],
      ],
    },
    s4: {
      eyebrow: '검증된 내보내기',
      title: '코드·표·수식까지 <hl>원본 그대로</hl>',
      sub: '내보낼 때마다 메시지, 이미지, 첨부, 파일 무결성을 검사하고 빠진 것이 있으면 숨기지 않고 알려 줍니다.',
      chips: ['코드', '표', '수식', '이미지', '첨부파일'],
    },
    s5: {
      eyebrow: '개인정보 보호',
      title: '모든 처리는 <hl>내 브라우저 안에서</hl>',
      sub: 'Lucian은 대화를 내 컴퓨터에서 파일로 만듭니다. 개발자나 다른 AI 서비스로 아무것도 보내지 않습니다.',
      cards: [
        ['server', '서버 없음', '대화를 어디에도 올리지 않습니다.'],
        ['ai', 'AI API 없음', '규칙 기반이라 LLM을 부르지 않습니다.'],
        ['eyeoff', '추적 없음', '통계·광고 도구가 없습니다.'],
        ['user', '설정 없음', '가입도, 설정도 필요 없습니다.'],
        ['key', '토큰 저장 안 함', '로그인 정보를 저장하지 않습니다.'],
        ['bolt', '빠른 처리', '100만 토큰 대화도 약 1초.'],
      ],
      sitesLabel: '지원 사이트',
    },
    small: { tagline: 'AI 대화 인수인계 · 내보내기' },
    marquee: { headline: 'AI 대화, <hl>인수인계부터 문서 저장까지</hl>' },
  },
};
