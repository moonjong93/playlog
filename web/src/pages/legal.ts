import { html } from "hono/html";
import {
  LEGAL_EFFECTIVE_DATE,
  SITE_CONTACT_EMAIL,
  SITE_NAME,
} from "../site.ts";
import { layout, type Html } from "./layout.ts";

/** 문의 주소를 그대로 보여주는 mailto 링크. */
function contactLink() {
  return html`<a href="mailto:${SITE_CONTACT_EMAIL}">${SITE_CONTACT_EMAIL}</a>`;
}

/**
 * 안내·법적 문서 공용 레이아웃. 본문은 기사 본문과 같은 `.article-body`
 * 타이포그래피를 재사용한다. 법적 문서(방침·약관)에만 시행일을 붙인다.
 */
function docPage(options: {
  title: string;
  description: string;
  path: string;
  origin?: string;
  legal?: boolean;
  body: Html;
}) {
  return layout({
    title: `${options.title} · ${SITE_NAME}`,
    description: options.description,
    canonical: options.path,
    origin: options.origin,
    body: html`<article class="article-body max-w-3xl">
      <h1
        class="text-headline-xl max-md:text-headline-xl-mobile font-headline-xl font-bold text-on-surface tracking-tight leading-tight"
      >
        ${options.title}
      </h1>
      ${options.legal
        ? html`<p class="text-label-mono-sm font-label-mono-sm text-outline mt-2 mb-6">
            시행일 ${LEGAL_EFFECTIVE_DATE}
          </p>`
        : ""}
      ${options.body}
    </article>`,
  });
}

export function aboutPage(options: { origin?: string } = {}) {
  return docPage({
    title: "소개",
    description:
      "PLAYLOG는 게임 업계 곳곳의 공개된 이야기를 모아 게임의 흐름을 따라갈 수 있도록 매일 한국어로 정리해 전하는 뉴스 서비스입니다.",
    path: "/about",
    origin: options.origin,
    body: html`<p>
      PLAYLOG는 게임 업계 곳곳에서 오가는 공개된 이야기를 모아, 게임의 흐름을
      따라갈 수 있도록 매일 한국어로 정리해 전하는 뉴스 서비스입니다. 바쁜 하루에도
      무슨 일이 있었고 어떤 이야기가 오가고 있는지 빠르게 살펴볼 수 있도록 돕습니다.
    </p>
    <h2>무엇을 전하나요?</h2>
    <ul>
      <li><strong>소식</strong> — 각 매체의 공개 RSS 피드와 커뮤니티의 공개 글을 모읍니다.</li>
      <li><strong>정리</strong> — 같은 사건을 다루는 소식을 한데 묶어 한국어로 정리합니다.</li>
      <li><strong>흐름</strong> — 원문 출처 링크와 함께 올리고, 태그로 관심 주제를 따라갑니다.</li>
    </ul>
    <h2>알아두세요</h2>
    <ul>
      <li>
        정리된 내용은 원문을 바탕으로 한 요약이라 원문과 차이가 있거나 오류가 있을
        수 있습니다. 정확한 내용은 기사 하단의 원문 출처에서 확인해 주세요.
      </li>
      <li>회원가입과 로그인이 없고, 광고나 추적 쿠키를 쓰지 않습니다.</li>
      <li>
        기사에 문제가 있으면 ${contactLink()}로 알려주세요. 확인 후 정정하거나
        내립니다.
      </li>
    </ul>
    <h2>문의</h2>
    <p>${contactLink()}</p>`,
  });
}

export function privacyPage(options: { origin?: string } = {}) {
  return docPage({
    title: "개인정보 처리방침",
    description:
      "PLAYLOG가 어떤 정보를 어떤 목적으로 처리하고 얼마 동안 보관하는지 안내합니다.",
    path: "/privacy",
    origin: options.origin,
    legal: true,
    body: html`<p>
      PLAYLOG(이하 "서비스")는 이용자의 정보를 소중히 다루며, 아래와 같이 처리
      방침을 안내합니다.
    </p>
    <h2>1. 수집하는 정보</h2>
    <p>
      서비스는 회원가입이 없으며, 이름·전화번호·주민등록번호 같은 고유식별정보를
      요구하지 않습니다. 실제로 처리하는 정보는 다음과 같습니다.
    </p>
    <ul>
      <li>
        <strong>익명 세션 쿠키(sid)</strong> — 무작위로 만든 식별자입니다. 댓글
        작성자 확인과 요청 제한(레이트 리밋)에만 씁니다.
      </li>
      <li>
        <strong>접속 IP</strong> — 과도한 요청을 막기 위해 서버 메모리에서만 잠시
        사용하며 별도로 저장하지 않습니다.
      </li>
      <li>
        <strong>댓글 정보</strong> — 닉네임(선택, 비우면 "익명"), 댓글 내용, 세션
        식별자, 작성 시각. 스팸 방지를 위해 IP를 되돌릴 수 없는 해시(HMAC-SHA256)
        값으로 바꿔 함께 저장하며, 원본 IP는 저장하지 않습니다.
      </li>
      <li>
        <strong>서버 운영 기록</strong> — 장애 대응을 위한 오류 로그. 서비스는
        Cloudflare 터널을 거치므로 보안 목적의 접속 기록이 Cloudflare에서
        처리될 수 있습니다.
      </li>
    </ul>
    <h2>2. 이용 목적</h2>
    <ul>
      <li>뉴스 요약·발행과 댓글 기능 제공</li>
      <li>과도한 요청·스팸 등 남용 방지</li>
      <li>문의 응대</li>
    </ul>
    <h2>3. 보유 기간과 파기</h2>
    <ul>
      <li>세션 쿠키 — 최대 1년. 브라우저에서 언제든 삭제할 수 있습니다.</li>
      <li>레이트 리밋용 IP — 서버 메모리에서 수 분 안에 사라집니다.</li>
      <li>
        댓글 — 작성자가 삭제하면 공개 화면에서 즉시 사라지고 복구되지 않습니다.
        그 밖의 정보는 서비스 운영 기간 동안 보관하며, 보유 목적이 끝나면 지체
        없이 파기합니다.
      </li>
    </ul>
    <h2>4. 제3자 제공</h2>
    <p>
      이용자의 개인정보를 제3자에게 판매하거나 제공하지 않습니다. 법령에 따라
      수사기관 등이 적법하게 요청하는 경우에만 예외로 합니다.
    </p>
    <h2>5. 처리 위탁과 국외 이전</h2>
    <p>
      서비스 제공을 위해 아래 사업자의 인프라를 이용하며, 이 과정에서 접속 정보가
      해외 서버를 경유할 수 있습니다.
    </p>
    <ul>
      <li><strong>Cloudflare</strong> — 트래픽 전달과 보안</li>
      <li>
        <strong>Google Fonts</strong> — 웹 폰트 제공(폰트를 받는 과정에서 접속
        IP가 Google에 전달될 수 있습니다)
      </li>
    </ul>
    <h2>6. 쿠키</h2>
    <p>
      서비스는 로그인·추적·광고 목적의 쿠키를 쓰지 않습니다. 사용하는 쿠키는 익명
      세션 식별자(sid) 하나뿐이며, 브라우저 설정에서 쿠키를 막을 수 있습니다.
      다만 이 경우 댓글 작성이 제한될 수 있습니다.
    </p>
    <h2>7. 이용자의 권리</h2>
    <ul>
      <li>댓글은 기사 화면에서 직접 삭제할 수 있습니다.</li>
      <li>
        그 밖에 개인정보의 열람·정정·삭제를 원하면 아래 문의 주소로 요청해
        주세요. 본인 확인 후 지체 없이 처리합니다.
      </li>
      <li>서비스는 만 14세 미만 아동의 개인정보를 수집하지 않습니다.</li>
    </ul>
    <h2>8. 보호책임자</h2>
    <ul>
      <li>보호책임자 — PLAYLOG 운영자</li>
      <li>이메일 — ${contactLink()}</li>
    </ul>
    <h2>9. 방침의 변경</h2>
    <p>이 방침이 바뀌면 이 페이지에 게시하고 시행일을 밝힙니다.</p>`,
  });
}

export function termsPage(options: { origin?: string } = {}) {
  return docPage({
    title: "이용약관",
    description:
      "PLAYLOG 이용 조건과 운영자·이용자의 권리와 의무를 정한 약관입니다.",
    path: "/terms",
    origin: options.origin,
    legal: true,
    body: html`<h2>1. 목적</h2>
    <p>
      이 약관은 PLAYLOG(이하 "서비스")의 이용 조건과 운영자·이용자의 권리와 의무를
      정합니다.
    </p>
    <h2>2. 서비스의 내용</h2>
    <ul>
      <li>
        서비스는 각 매체와 커뮤니티에 공개된 소식을 모아 한국어로 정리해 보여주는
        무료 뉴스 서비스입니다.
      </li>
      <li>회원가입 없이 누구나 읽을 수 있고, 기사에 익명으로 댓글을 쓸 수 있습니다.</li>
      <li>서비스는 별도 고지 없이 내용을 바꾸거나 중단할 수 있습니다.</li>
    </ul>
    <h2>3. 약관의 효력과 변경</h2>
    <ul>
      <li>이 약관은 사이트에 게시함으로써 효력이 생깁니다.</li>
      <li>
        약관을 바꾸면 이 페이지에 게시하고 시행일을 밝힙니다. 바뀐 약관에
        동의하지 않으면 서비스 이용을 중단할 수 있습니다.
      </li>
    </ul>
    <h2>4. 이용자의 의무</h2>
    <p>이용자는 다음 행위를 해서는 안 됩니다.</p>
    <ul>
      <li>자동화된 수단으로 과도하게 접속하거나 서버에 부담을 주는 행위</li>
      <li>다른 사람을 비방·차별하거나 불법 정보를 유포하는 행위</li>
      <li>광고·도배 등 서비스 목적에 맞지 않는 댓글을 반복해서 쓰는 행위</li>
      <li>타인을 사칭하거나 저작권 등 권리를 침해하는 행위</li>
      <li>서비스 운영을 방해하는 그 밖의 행위</li>
    </ul>
    <h2>5. 댓글의 관리</h2>
    <ul>
      <li>댓글의 내용에 대한 책임은 작성자에게 있습니다.</li>
      <li>
        운영자는 위 4항을 어긴 댓글을 사전 통보 없이 삭제하거나 작성을 제한할 수
        있습니다.
      </li>
    </ul>
    <h2>6. 지식재산권</h2>
    <ul>
      <li>서비스가 만든 요약문·편집물·디자인에 대한 권리는 PLAYLOG에 있습니다.</li>
      <li>
        원문 기사, 이미지, 상표 등은 각 권리자에게 있습니다. 서비스는 출처를 밝히고
        원문으로 연결합니다.
      </li>
      <li>
        권리 침해가 있다고 판단되면 ${contactLink()}로 알려주세요. 확인 후 지체
        없이 정정하거나 삭제합니다.
      </li>
    </ul>
    <h2>7. 콘텐츠의 한계</h2>
    <ul>
      <li>정리된 내용은 원문을 바탕으로 한 요약이며, 원문과 다르거나 부정확할 수 있습니다.</li>
      <li>
        서비스의 내용은 참고용이며 투자·법률·의료 등의 전문적 조언이 아닙니다.
        중요한 판단은 원문과 전문가를 통해 확인하세요.
      </li>
    </ul>
    <h2>8. 책임의 제한</h2>
    <ul>
      <li>
        서비스는 무료로 제공되며, 운영자는 법이 허용하는 범위에서 서비스 이용으로
        생긴 손해에 대해 책임지지 않습니다.
      </li>
      <li>
        다만 운영자의 고의나 중대한 과실로 생긴 손해에는 이 제한을 적용하지
        않습니다.
      </li>
    </ul>
    <h2>9. 준거법과 분쟁</h2>
    <ul>
      <li>이 약관은 대한민국 법을 따릅니다.</li>
      <li>서비스와 관련한 분쟁은 운영자 주소지를 관할하는 법원에서 다룹니다.</li>
    </ul>
    <h2>10. 문의</h2>
    <p>${contactLink()}</p>`,
  });
}

export function contactPage(options: { origin?: string } = {}) {
  return docPage({
    title: "문의",
    description: `PLAYLOG에 관한 의견, 오류 제보, 기사 정정·삭제 요청은 ${SITE_CONTACT_EMAIL}로 받습니다.`,
    path: "/contact",
    origin: options.origin,
    body: html`<p>
      서비스에 관한 의견, 오류 제보, 기사 정정·삭제 요청을 아래 이메일로
      받습니다.
    </p>
    <p class="mt-4">
      <a
        class="inline-block px-4 py-2 rounded border border-outline-variant bg-surface-container hover:bg-surface-container-high"
        href="mailto:${SITE_CONTACT_EMAIL}"
        >${SITE_CONTACT_EMAIL}</a
      >
    </p>
    <h2>이런 내용을 보내주시면 됩니다</h2>
    <ul>
      <li>
        <strong>기사 정정·삭제 요청</strong>(권리 침해 포함) — 기사 제목이나 링크를
        함께 보내주세요.
      </li>
      <li><strong>번역·요약 오류 제보</strong></li>
      <li><strong>댓글 신고</strong></li>
      <li><strong>서비스 제안·제휴</strong></li>
    </ul>
    <p>
      확인 후 영업일 기준 2~3일 안에 답변드리는 것을 목표로 합니다. 개인정보 관련
      요청도 같은 주소로 받습니다.
    </p>`,
  });
}
