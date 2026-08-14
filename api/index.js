const axios = require('axios');
const { JSDOM } = require('jsdom');
const https = require('https');

// Bright Data ISP Proxy Configuration
const BD_PROXY = {
  host: 'brd.superproxy.io',
  port: 44445,
  auth: {
    username: 'brd-customer-hl_464d4bc4-zone-isp_proxy1-country-in',
    password: 'j4jr8z8dmcji'
  }
};

module.exports = async (req, res) => {
  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    if (req.method === 'OPTIONS') return res.status(200).end();

    const startTime = Date.now();
    let html = '', targetUrl = '', fetchedVia = '';

    if (req.method === 'POST') {
      const body = req.body;
      if (body?.html) html = body.html;
      else if (typeof body === 'string') html = body;
      if (html) fetchedVia = 'direct_post';
    }

    if (!html) {
      targetUrl = req.query.url || '';
      if (!targetUrl) return res.status(200).json({ success: false, error: 'Missing ?url= parameter' });

      if (targetUrl.includes('%3A') || targetUrl.includes('%2F')) {
        targetUrl = decodeURIComponent(targetUrl);
      }

      if (!targetUrl.startsWith('http')) {
        return res.status(200).json({ success: false, error: 'Invalid URL.' });
      }

      const isDigialm = /digialm\.com|tcsion\.com|AssessmentQP|touchstone|per\/g/i.test(targetUrl);
      if (!isDigialm) {
        return res.status(200).json({ success: false, error: 'No data found or Invalid/Expired Answer Key URL.' });
      }

      try {
        const r = await axios.get(targetUrl, {
          timeout: 5000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9'
          },
          httpsAgent: new https.Agent({ rejectUnauthorized: false })
        });
        if (r.data && typeof r.data === 'string' && r.data.length > 200 && r.data.includes('main-info-pnl')) {
          html = r.data;
          fetchedVia = 'direct_vps';
        }
      } catch (e) {}

      if (!html) {
        try {
          const r = await axios.get(targetUrl, {
            timeout: 15000,
            proxy: BD_PROXY,
            httpsAgent: new https.Agent({ rejectUnauthorized: false }),
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
              'Accept-Language': 'en-US,en;q=0.9',
              'Cache-Control': 'no-cache'
            }
          });
          if (r.data && typeof r.data === 'string' && r.data.length > 200 && r.data.includes('main-info-pnl')) {
            html = r.data;
            fetchedVia = 'bright_data_isp_proxy';
          }
        } catch (e) {}
      }
    }

    if (!html || html.length < 100 || !html.includes('main-info-pnl')) {
      return res.status(200).json({ success: false, error: 'No data found or Invalid/Expired Answer Key URL.' });
    }

    const result = parseHTML(html, targetUrl);

    return res.status(200).json({
      success: true,
      fetched_via: fetchedVia,
      header_banner_img: result.headerBannerImg,
      header_banner_text: result.headerBannerText,
      candidate_info: result.candidateInfo,
      score_summary: {
        total_questions: result.questions.length,
        attempted: result.totalAttempted,
        unattempted: result.totalUnattempted,
        correct_answers: result.totalRight,
        wrong_answers: result.totalWrong,
        marks_obtained: result.marksObtained
      },
      sections_list: result.sectionNames,
      section_summary: result.sectionSummary,
      questions_summary: result.questions,
      execution_time: `${Date.now() - startTime} ms`
    });
  } catch (err) {
    return res.status(200).json({
      success: false,
      error: 'An internal error occurred while processing the request.'
    });
  }
};

function parseHTML(html, targetUrl) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  function normText(t) {
    return t ? t.replace(/[\u00A0\u200B]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  }

  function makeAbsUrl(src) {
    if (!src) return '';
    if (src.startsWith('data:image/')) return src;
    if (src.startsWith('http')) return src.replace(/(?<!:)\/\/+/g, '/');

    if (targetUrl) {
      try {
        const u = new URL(targetUrl);
        const scheme = u.protocol;
        const host = u.host;
        if (src.startsWith('/')) {
          return `${scheme}//${host}${src.replace(/\/\/+/g, '/')}`;
        } else {
          const path = u.pathname || '/';
          const dir = path.substring(0, path.lastIndexOf('/')).replace(/\\/g, '/');
          const fullPath = `${dir}/${src}`.replace(/\/\/+/g, '/');
          return `${scheme}//${host}${fullPath}`;
        }
      } catch (e) {}
    }
    return src.replace(/(?<!:)\/\/+/g, '/');
  }

  function chosenToIndex(s) {
    if (!s) return null;
    s = s.trim();
    if (!s || s === '--' || /not answered/i.test(s)) return null;
    if (/^[A-D]$/i.test(s)) return s.toUpperCase().charCodeAt(0) - 64;
    const m1 = s.match(/^(\d+)$/); if (m1) return parseInt(m1[1]);
    const m2 = s.match(/\b([1-4])\b/); if (m2) return parseInt(m2[1]);
    const m3 = s.match(/([1-4])/); if (m3) return parseInt(m3[1]);
    const m4 = s.match(/\b([A-D])\b/i); if (m4) return m4[1].toUpperCase().charCodeAt(0) - 64;
    return null;
  }

  function classifyAndProcessNode(node, isOption = false) {
    if (!node) return { text: "", image: "", html: "" };

    const cloned = node.cloneNode(true);
    const imgs = [...cloned.querySelectorAll('img')];
    const validImgs = [];
    const toRemove = [];

    imgs.forEach(img => {
      const src = img.getAttribute('src') || '';
      if (/tick\.png|cross\.png/i.test(src)) {
        toRemove.push(img);
      } else {
        const absSrc = makeAbsUrl(src);
        while (img.attributes.length > 0) {
          img.removeAttribute(img.attributes[0].name);
        }
        img.setAttribute('src', absSrc);
        validImgs.push(absSrc);
      }
    });

    toRemove.forEach(rImg => {
      if (rImg.parentNode) rImg.parentNode.removeChild(rImg);
    });

    const rawText = normText(cloned.textContent);
    const cleanCheckText = rawText.replace(/^(?:Q\.\s*\d+|[A-D][\.\)\s]*)/i, '').trim();

    const hasText = Boolean(cleanCheckText);
    const hasImage = validImgs.length > 0;

    let innerHtml = cloned.innerHTML || '';
    innerHtml = innerHtml.replace(/<sup>\s*<\/sup>/gi, '')
                         .replace(/<sub>\s*<\/sub>/gi, '')
                         .replace(/\s+/g, ' ')
                         .trim();

    if (hasText && !hasImage) {
      return { text: rawText, image: "", html: "" };
    } else if (!hasText && hasImage) {
      return { text: "", image: validImgs[0], html: "" };
    } else {
      return { text: "", image: "", html: innerHtml };
    }
  }

  // Multi-layer Smart Header Banner Image & Header Banner Text Detection
  let headerBannerImg = '';
  let headerBannerText = '';

  const imgNodes = doc.querySelectorAll('.header-image img, .main-info-pnl img, table.main-info-pnl img, img[src*="banner"], img[src*="Banner"], img[src*="logo"], img[src*="header"]');
  for (const imgNode of imgNodes) {
    const rawSrc = imgNode.getAttribute('src') || '';
    if (rawSrc && !/tick\.png|cross\.png/i.test(rawSrc)) {
      headerBannerImg = makeAbsUrl(rawSrc);
      break;
    }
  }

  if (!headerBannerImg) {
    const textSelectors = [
      '.header-image',
      '.header-text',
      '.header-title',
      'div[style*="text-align:center"]',
      'div[style*="text-align: center"]',
      'h1', 'h2', 'h3'
    ];

    for (const sel of textSelectors) {
      const nodes = doc.querySelectorAll(sel);
      for (const node of nodes) {
        if (!node.querySelector('table.main-info-pnl')) {
          const txt = normText(node.textContent);
          if (txt && txt.length > 3 && !/question|option/i.test(txt)) {
            headerBannerText = txt;
            break;
          }
        }
      }
      if (headerBannerText) break;
    }
  }

  const candidateInfo = {};
  doc.querySelectorAll('.main-info-pnl tr, table.main-info-pnl tr').forEach(tr => {
    const tds = tr.querySelectorAll('td');
    if (tds.length >= 2) {
      const k = normText(tds[0].textContent).replace(/:$/, '');
      const v = normText(tds[1].textContent);
      if (k && v && !/note|\*/i.test(k)) candidateInfo[k] = v;
    }
  });

  const sectionNames = [];
  doc.querySelectorAll('.section-lbl, .secName, .sec-lbl, td.section-lbl').forEach(s => {
    const name = normText(s.textContent).replace(/^Section\s*:\s*/i, '').trim();
    if (name && !sectionNames.includes(name)) sectionNames.push(name);
  });

  let qTables = [...doc.querySelectorAll('table.questionRowTbl')];
  if (!qTables.length) qTables = [...doc.querySelectorAll('div.question-pnl')];

  const questions = [];
  const sectionSummary = {};
  let totalRight = 0;
  let totalWrong = 0;
  let totalUnattempted = 0;
  let idx = 1;

  const allSecHeaderNodes = [...doc.querySelectorAll('.section-lbl, .sec-lbl, .secName, td.section-lbl')];

  qTables.forEach(q => {
    let chosenRaw = null;
    const menuData = {};

    let qSecName = 'General Section';
    let lastPrecedingHeader = null;

    allSecHeaderNodes.forEach(secHeader => {
      if (q.compareDocumentPosition(secHeader) & 2) {
        lastPrecedingHeader = secHeader;
      }
    });

    if (lastPrecedingHeader) {
      const secText = normText(lastPrecedingHeader.textContent).replace(/^Section\s*:\s*/i, '').trim();
      if (secText) qSecName = secText;
    }

    let parent = q.parentNode;
    let menuTable = null;

    if (parent) {
      const tds = parent.querySelectorAll('td');
      tds.forEach(td => {
        const txt = normText(td.textContent);
        if (/chosen option/i.test(txt)) {
          const tr = td.parentNode;
          if (tr) {
            const m = normText(tr.textContent).match(/chosen option\s*:\s*(\S+)/i);
            if (m) chosenRaw = m[1].trim();
          }
          let cur = td.parentNode;
          while (cur && cur.tagName !== 'TABLE') cur = cur.parentNode;
          if (cur) menuTable = cur;
        }
      });
    }

    if (menuTable) {
      menuTable.querySelectorAll('tr').forEach(mtr => {
        const txt = normText(mtr.textContent);
        if (txt.includes(':')) {
          const [k, ...r] = txt.split(':');
          menuData[k.trim()] = r.join(':').trim();
        }
      });
    }

    const qId = menuData['Question ID'] || null;
    const qType = menuData['Question Type'] || 'MCQ';
    const optIds = {};
    for (let i = 1; i <= 4; i++) { if (menuData[`Option ${i} ID`]) optIds[i] = menuData[`Option ${i} ID`]; }

    const qTds = q.querySelectorAll('td.qText, td.questionText, td.bold');
    const qTd = qTds.length >= 2 ? qTds[1] : qTds[0];
    const qData = classifyAndProcessNode(qTd, false);

    const opts = [...q.querySelectorAll('td.rightAns, td.wrngAns, tr.rightAns td, tr.wrngAns td')];
    const uniqueOpts = [];
    opts.forEach(opt => {
      if (opt.tagName === 'TD' && !uniqueOpts.includes(opt)) {
        uniqueOpts.push(opt);
      }
    });

    const options = [];
    let rightText = 'N/A';
    let rightPos = null;

    uniqueOpts.forEach((opt, i) => {
      const num = i + 1;
      const cls = opt.getAttribute('class') || opt.parentNode?.getAttribute('class') || '';
      const isCorrect = /rightAns/i.test(cls);
      
      const optData = classifyAndProcessNode(opt, true);
      
      if (isCorrect) {
        rightText = normText(opt.textContent);
        rightPos = num;
      }
      options.push({
        option_no: num,
        option_id: optIds[num] || null,
        option_text: optData.text,
        option_image: optData.image,
        option_html: optData.html,
        is_correct: isCorrect
      });
    });

    const ci = chosenToIndex(chosenRaw);
    let status = 'Unattempted';
    const chosenOptId = (ci && optIds[ci]) ? optIds[ci] : null;

    if (ci === null) {
      status = 'Unattempted';
      totalUnattempted++;
    } else if (rightPos !== null && ci === rightPos) {
      status = 'Correct';
      totalRight++;
    } else {
      status = 'Wrong';
      totalWrong++;
    }

    if (!sectionSummary[qSecName]) {
      sectionSummary[qSecName] = {
        total_questions: 0,
        attempted: 0,
        unattempted: 0,
        correct_answers: 0,
        wrong_answers: 0,
        marks_obtained: 0.0
      };
    }

    sectionSummary[qSecName].total_questions++;
    if (status === 'Correct') {
      sectionSummary[qSecName].correct_answers++;
      sectionSummary[qSecName].attempted++;
    } else if (status === 'Wrong') {
      sectionSummary[qSecName].wrong_answers++;
      sectionSummary[qSecName].attempted++;
    } else {
      sectionSummary[qSecName].unattempted++;
    }

    questions.push({
      q_no: idx++,
      question_id: qId,
      question_type: qType,
      section: qSecName,
      question_text: qData.text,
      question_image: qData.image,
      question_html: qData.html,
      options: options,
      chosen_option: chosenRaw || 'Not Answered',
      chosen_option_id: chosenOptId,
      right_option: rightText,
      right_option_no: rightPos,
      status: status
    });
  });

  for (const s in sectionSummary) {
    sectionSummary[s].marks_obtained = parseFloat(
      ((sectionSummary[s].correct_answers * 1.0) - (sectionSummary[s].wrong_answers * 0.25)).toFixed(2)
    );
  }

  const totalAttempted = totalRight + totalWrong;
  const marksObtained = parseFloat(((totalRight * 1.0) - (totalWrong * 0.25)).toFixed(2));

  return {
    headerBannerImg,
    headerBannerText,
    candidateInfo,
    sectionNames,
    sectionSummary,
    questions,
    totalRight,
    totalWrong,
    totalUnattempted,
    totalAttempted,
    marksObtained
  };
}
