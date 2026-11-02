// Brodoit Jyotish words (v34): every reading the palm and kundli pages show, in English and Hindi, written for Brodoit.
// Classic script (window.AstroText) and Node module (tests). Entries are { en, hi } or arrays of them.
// Palmistry and astrology are traditions for reflection: nothing here predicts illness, death or lifespan.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AstroText = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const T = (en, hi) => ({ en, hi });

  const SIGNS = [
    { n: 'Aries', v: 'Mesha', h: 'मेष', ab: 'Ar' }, { n: 'Taurus', v: 'Vrishabha', h: 'वृषभ', ab: 'Ta' },
    { n: 'Gemini', v: 'Mithuna', h: 'मिथुन', ab: 'Ge' }, { n: 'Cancer', v: 'Karka', h: 'कर्क', ab: 'Cn' },
    { n: 'Leo', v: 'Simha', h: 'सिंह', ab: 'Le' }, { n: 'Virgo', v: 'Kanya', h: 'कन्या', ab: 'Vi' },
    { n: 'Libra', v: 'Tula', h: 'तुला', ab: 'Li' }, { n: 'Scorpio', v: 'Vrishchika', h: 'वृश्चिक', ab: 'Sc' },
    { n: 'Sagittarius', v: 'Dhanu', h: 'धनु', ab: 'Sg' }, { n: 'Capricorn', v: 'Makara', h: 'मकर', ab: 'Cp' },
    { n: 'Aquarius', v: 'Kumbha', h: 'कुंभ', ab: 'Aq' }, { n: 'Pisces', v: 'Meena', h: 'मीन', ab: 'Pi' },
  ];
  const SIGN_TRAIT = [
    T('Direct, brave and quick to start. You like to lead and to move first; patience is your lesson.', 'सीधे, साहसी और शुरुआत करने में तेज़। आगे रहना और पहला कदम उठाना पसंद है; धैर्य आपका सबक है।'),
    T('Steady, loyal and fond of comfort, good food and beauty. Slow to change your mind, and hard to shake.', 'स्थिर, वफ़ादार, और आराम, अच्छे खाने व सुंदरता के शौक़ीन। राय धीरे बदलते हैं और आसानी से डगमगाते नहीं।'),
    T('Curious, witty and quick with words. You learn fast and need variety; finishing what you start is your lesson.', 'जिज्ञासु, हाज़िरजवाब और बातों में तेज़। जल्दी सीखते हैं, बदलाव चाहिए; शुरू किया काम पूरा करना आपका सबक है।'),
    T('Caring, protective and tied to home and family. Your feelings run deep and your memory is long.', 'देखभाल करने वाले, रक्षक, और घर-परिवार से गहराई से जुड़े। भावनाएँ गहरी हैं और याददाश्त लंबी।'),
    T('Warm, proud and generous. You shine when people count on you, and you need respect more than praise.', 'गर्मजोशी भरे, स्वाभिमानी और उदार। जब लोग आप पर भरोसा करें तब चमकते हैं; तारीफ़ से ज़्यादा सम्मान चाहिए।'),
    T('Careful, helpful and sharp with details. You fix what others miss; go easy on yourself.', 'सावधान, मददगार और बारीकियों में तेज़। जो दूसरे चूक जाएँ, वह आप सुधारते हैं; ख़ुद पर थोड़ा नरम रहें।'),
    T('Fair, charming and good at bringing people together. You weigh every side; deciding quickly is your lesson.', 'न्यायप्रिय, आकर्षक और लोगों को जोड़ने में अच्छे। हर पहलू तौलते हैं; जल्दी फ़ैसला लेना आपका सबक है।'),
    T('Intense, private and determined. You see beneath the surface and never do things halfway.', 'गहरे, निजी और दृढ़ निश्चयी। सतह के नीचे देखते हैं और कोई काम आधा नहीं करते।'),
    T('Optimistic, honest and drawn to big ideas, travel and teachers. Freedom keeps you happy.', 'आशावादी, ईमानदार, और बड़े विचारों, यात्रा और गुरुओं की ओर खिंचते हैं। आज़ादी आपको ख़ुश रखती है।'),
    T('Patient, disciplined and ambitious. You build slowly and it lasts; make room for rest.', 'धैर्यवान, अनुशासित और महत्वाकांक्षी। धीरे बनाते हैं और वह टिकता है; आराम के लिए भी जगह रखें।'),
    T('Independent, inventive and fair-minded. You think of the group and the future, sometimes more than of yourself.', 'स्वतंत्र, नई सोच वाले और न्यायप्रिय। समूह और भविष्य के बारे में सोचते हैं, कभी-कभी ख़ुद से ज़्यादा।'),
    T('Gentle, imaginative and kind. You feel what others feel; protect your energy and your dreams.', 'कोमल, कल्पनाशील और दयालु। दूसरों का दर्द महसूस करते हैं; अपनी ऊर्जा और सपनों को बचाकर रखें।'),
  ];

  const PLANETS = {
    sun: { n: 'Sun', v: 'Surya', h: 'सूर्य', ab: 'Su', abh: 'सू', kw: T('confidence, father and authority', 'आत्मविश्वास, पिता और अधिकार') },
    moon: { n: 'Moon', v: 'Chandra', h: 'चंद्र', ab: 'Mo', abh: 'चं', kw: T('mind, mother and feelings', 'मन, माँ और भावनाएँ') },
    mars: { n: 'Mars', v: 'Mangal', h: 'मंगल', ab: 'Ma', abh: 'मं', kw: T('energy, courage and drive', 'ऊर्जा, साहस और जोश') },
    mercury: { n: 'Mercury', v: 'Budh', h: 'बुध', ab: 'Me', abh: 'बु', kw: T('intellect, speech and trade', 'बुद्धि, वाणी और व्यापार') },
    jupiter: { n: 'Jupiter', v: 'Guru', h: 'गुरु', ab: 'Ju', abh: 'गु', kw: T('wisdom, teachers and growth', 'ज्ञान, गुरु और बढ़त') },
    venus: { n: 'Venus', v: 'Shukra', h: 'शुक्र', ab: 'Ve', abh: 'शु', kw: T('love, beauty and comfort', 'प्रेम, सुंदरता और सुख') },
    saturn: { n: 'Saturn', v: 'Shani', h: 'शनि', ab: 'Sa', abh: 'श', kw: T('discipline, hard work and patience', 'अनुशासन, मेहनत और धैर्य') },
    rahu: { n: 'Rahu', v: 'Rahu', h: 'राहु', ab: 'Ra', abh: 'रा', kw: T('ambition, the new and the foreign', 'महत्वाकांक्षा, नई और विदेशी चीज़ें') },
    ketu: { n: 'Ketu', v: 'Ketu', h: 'केतु', ab: 'Ke', abh: 'के', kw: T('detachment, insight and past skills', 'वैराग्य, अंतर्दृष्टि और पुराने हुनर') },
  };
  const HOUSES = [null,
    T('self, body and the way you come across', 'स्वयं, शरीर और आपका व्यक्तित्व'),
    T('money, family, speech and food', 'धन, परिवार, वाणी और भोजन'),
    T('courage, siblings, short trips and skills', 'साहस, भाई-बहन, छोटी यात्राएँ और हुनर'),
    T('home, mother, comfort and property', 'घर, माँ, सुख और संपत्ति'),
    T('children, creativity, studies and romance', 'संतान, रचनात्मकता, पढ़ाई और प्रेम'),
    T('daily work, health, rivals and loans', 'रोज़ का काम, सेहत, विरोधी और कर्ज़'),
    T('marriage, partners and business deals', 'विवाह, साझेदार और व्यापारिक सौदे'),
    T('change, secrets, research and inheritance', 'बदलाव, रहस्य, शोध और विरासत'),
    T('luck, father, teachers, faith and long journeys', 'भाग्य, पिता, गुरु, धर्म और लंबी यात्राएँ'),
    T('career, status and public life', 'करियर, पद और सार्वजनिक जीवन'),
    T('gains, friends and wishes', 'लाभ, मित्र और इच्छाएँ'),
    T('expenses, sleep, foreign lands and spiritual life', 'ख़र्च, नींद, विदेश और आध्यात्मिक जीवन'),
  ];
  const DIGNITY = {
    exalted: T('strong here (exalted)', 'यहाँ बलवान (उच्च)'),
    debilitated: T('weak here (debilitated): its results come with effort', 'यहाँ कमज़ोर (नीच): इसका फल मेहनत से मिलता है'),
    own: T('at home in its own sign', 'अपनी ही राशि में, सहज'),
  };

  const NAKSHATRAS = [
    ['Ashwini', 'अश्विनी'], ['Bharani', 'भरणी'], ['Krittika', 'कृत्तिका'], ['Rohini', 'रोहिणी'], ['Mrigashira', 'मृगशिरा'],
    ['Ardra', 'आर्द्रा'], ['Punarvasu', 'पुनर्वसु'], ['Pushya', 'पुष्य'], ['Ashlesha', 'आश्लेषा'], ['Magha', 'मघा'],
    ['Purva Phalguni', 'पूर्वा फाल्गुनी'], ['Uttara Phalguni', 'उत्तरा फाल्गुनी'], ['Hasta', 'हस्त'], ['Chitra', 'चित्रा'],
    ['Swati', 'स्वाति'], ['Vishakha', 'विशाखा'], ['Anuradha', 'अनुराधा'], ['Jyeshtha', 'ज्येष्ठा'], ['Mula', 'मूल'],
    ['Purva Ashadha', 'पूर्वाषाढ़ा'], ['Uttara Ashadha', 'उत्तराषाढ़ा'], ['Shravana', 'श्रवण'], ['Dhanishta', 'धनिष्ठा'],
    ['Shatabhisha', 'शतभिषा'], ['Purva Bhadrapada', 'पूर्वा भाद्रपद'], ['Uttara Bhadrapada', 'उत्तरा भाद्रपद'], ['Revati', 'रेवती'],
  ].map(([en, hi]) => ({ en, hi }));
  const TITHIS = [
    ['Pratipada', 'प्रतिपदा'], ['Dwitiya', 'द्वितीया'], ['Tritiya', 'तृतीया'], ['Chaturthi', 'चतुर्थी'], ['Panchami', 'पंचमी'],
    ['Shashthi', 'षष्ठी'], ['Saptami', 'सप्तमी'], ['Ashtami', 'अष्टमी'], ['Navami', 'नवमी'], ['Dashami', 'दशमी'],
    ['Ekadashi', 'एकादशी'], ['Dwadashi', 'द्वादशी'], ['Trayodashi', 'त्रयोदशी'], ['Chaturdashi', 'चतुर्दशी'], ['Purnima', 'पूर्णिमा'],
  ].map(([en, hi]) => ({ en, hi }));
  const AMAVASYA = T('Amavasya', 'अमावस्या');
  const PAKSHA = { shukla: T('Shukla paksha', 'शुक्ल पक्ष'), krishna: T('Krishna paksha', 'कृष्ण पक्ष') };
  const YOGAS = [
    ['Vishkambha', 'विष्कंभ'], ['Priti', 'प्रीति'], ['Ayushman', 'आयुष्मान'], ['Saubhagya', 'सौभाग्य'], ['Shobhana', 'शोभन'],
    ['Atiganda', 'अतिगंड'], ['Sukarma', 'सुकर्मा'], ['Dhriti', 'धृति'], ['Shula', 'शूल'], ['Ganda', 'गंड'], ['Vriddhi', 'वृद्धि'],
    ['Dhruva', 'ध्रुव'], ['Vyaghata', 'व्याघात'], ['Harshana', 'हर्षण'], ['Vajra', 'वज्र'], ['Siddhi', 'सिद्धि'], ['Vyatipata', 'व्यतीपात'],
    ['Variyana', 'वरीयान'], ['Parigha', 'परिघ'], ['Shiva', 'शिव'], ['Siddha', 'सिद्ध'], ['Sadhya', 'साध्य'], ['Shubha', 'शुभ'],
    ['Shukla', 'शुक्ल'], ['Brahma', 'ब्रह्म'], ['Indra', 'इंद्र'], ['Vaidhriti', 'वैधृति'],
  ].map(([en, hi]) => ({ en, hi }));
  const WEEKDAYS = [
    T('Sunday', 'रविवार'), T('Monday', 'सोमवार'), T('Tuesday', 'मंगलवार'), T('Wednesday', 'बुधवार'),
    T('Thursday', 'गुरुवार'), T('Friday', 'शुक्रवार'), T('Saturday', 'शनिवार'),
  ];

  // the day from the Moon's transit house, counted from your Moon sign (Chandra gochar)
  const GOCHAR = [null,
    T('The Moon is in your own sign. Feelings are strong, and so is the pull to do things your way. Good for self-care, a new look or a personal start; try not to over-react.', 'चंद्रमा आपकी अपनी राशि में है। भावनाएँ तेज़ हैं, और अपने तरीक़े से काम करने का मन भी। अपनी देखभाल, नया रूप या कोई निजी शुरुआत अच्छी है; ज़्यादा प्रतिक्रिया न दें।'),
    T('Money, food and family are on your mind. Watch your spending and your words; one kind sentence goes far today.', 'पैसा, खाना और परिवार मन में रहेंगे। ख़र्च और शब्दों पर ध्यान दें; आज एक प्यार भरा वाक्य दूर तक जाएगा।'),
    T('Courage and energy are up. A good day for calls, messages, short trips, sport and asking for what you want.', 'हिम्मत और ऊर्जा बढ़ी हुई है। फ़ोन, संदेश, छोटी यात्रा, खेल और अपनी बात कहने के लिए अच्छा दिन।'),
    T('Home and comfort pull at you. Spend time with family; keep travel and big decisions simple.', 'घर और सुकून अपनी ओर खींचेंगे। परिवार के साथ समय बिताएँ; यात्रा और बड़े फ़ैसले सरल रखें।'),
    T('Creative and warm. Good for study, children, art and romance; skip risky bets.', 'रचनात्मक और प्यार भरा दिन। पढ़ाई, बच्चों, कला और प्रेम के लिए अच्छा; जोखिम भरे दाँव छोड़ें।'),
    T('A day to win. Clear pending work, start a health routine, settle a dispute; rivals lose their edge.', 'जीतने का दिन। अटका काम निपटाएँ, सेहत की दिनचर्या शुरू करें, विवाद सुलझाएँ; विरोधी कमज़ोर पड़ेंगे।'),
    T('People come first: partners, clients, meetings and dates go well. Listen as much as you talk.', 'आज लोग पहले: साथी, ग्राहक, मुलाक़ातें अच्छी रहेंगी। जितना बोलें, उतना सुनें भी।'),
    T('Energy is lower and plans may shift. Keep a buffer, avoid risks and arguments, and rest early; good for research and quiet work.', 'ऊर्जा कम है और योजनाएँ बदल सकती हैं। गुंजाइश रखें, जोखिम और बहस से बचें, जल्दी आराम करें; शोध और शांत काम के लिए ठीक।'),
    T('Luck and good advice are near. Talk to a teacher or an elder, plan a journey, give something away.', 'भाग्य और अच्छी सलाह पास हैं। किसी गुरु या बड़े से बात करें, यात्रा की योजना बनाएँ, कुछ दान करें।'),
    T('Work is in the spotlight. Do the important task first; your effort is noticed by the people who matter.', 'काम सुर्ख़ियों में है। ज़रूरी काम पहले करें; आपकी मेहनत सही लोगों की नज़र में आएगी।'),
    T('Gains and friends. Good news, help from your circle and a wish moving forward; reach out and ask.', 'लाभ और दोस्त। अच्छी ख़बर, अपनों से मदद, और कोई इच्छा आगे बढ़ेगी; मिलें और माँगें।'),
    T('A quiet, inward day. Expenses may rise; sleep well, pray or meditate, and let go of what you can\'t control.', 'शांत, भीतर देखने का दिन। ख़र्च बढ़ सकता है; अच्छी नींद लें, प्रार्थना या ध्यान करें, और जो बस में नहीं उसे छोड़ दें।'),
  ];
  // the day's star counted from your birth star (Tara bala)
  const TARA = [null,
    T('Janma (your own star): a mixed day, go steady', 'जन्म तारा: मिला-जुला दिन, संभलकर चलें'),
    T('Sampat (wealth): good for money matters', 'संपत तारा: पैसे के कामों के लिए अच्छा'),
    T('Vipat (obstacles): double-check before you commit', 'विपत तारा: पक्का करने से पहले दोबारा जाँचें'),
    T('Kshema (well-being): safe and steady', 'क्षेम तारा: सुरक्षित और स्थिर'),
    T('Pratyari (opposition): avoid conflict', 'प्रत्यरि तारा: टकराव से बचें'),
    T('Sadhaka (achievement): push your goals', 'साधक तारा: लक्ष्य की ओर बढ़ें'),
    T('Vadha (hard): postpone big starts', 'वध तारा: बड़ी शुरुआत टालें'),
    T('Mitra (friend): good company and help', 'मित्र तारा: अच्छा साथ और मदद'),
    T('Param mitra (best friend): very favourable', 'परम मित्र तारा: बहुत शुभ'),
  ];

  const DASHA_TEXT = {
    sun: T('Confidence, authority and dealings with your father or the government grow. Lead, but keep ego in check.', 'आत्मविश्वास, अधिकार, और पिता या सरकार से जुड़े काम बढ़ते हैं। नेतृत्व करें, पर अहंकार पर लगाम रखें।'),
    moon: T('Feelings, home, your mother and the public matter more. Good for caring work, travel and comfort.', 'भावनाएँ, घर, माँ और जनता से जुड़ाव अहम होते हैं। सेवा, यात्रा और सुकून के लिए अच्छा।'),
    mars: T('Energy, property, courage and competition. Act boldly, but watch anger and speed.', 'ऊर्जा, ज़मीन-जायदाद, साहस और मुक़ाबला। हिम्मत से काम लें, पर ग़ुस्से और जल्दबाज़ी पर ध्यान दें।'),
    mercury: T('Study, trade, writing and smart deals. A time to learn skills and to communicate.', 'पढ़ाई, व्यापार, लेखन और समझदारी के सौदे। हुनर सीखने और बातचीत का समय।'),
    jupiter: T('Growth, wisdom, children, teachers and good fortune. Expand, study and guide others.', 'बढ़त, ज्ञान, संतान, गुरु और सौभाग्य। आगे बढ़ें, पढ़ें और दूसरों का मार्गदर्शन करें।'),
    venus: T('Love, marriage, comforts, art and vehicles, over the longest period of all. Enjoy, but don\'t overspend.', 'प्रेम, विवाह, सुख-सुविधा, कला और वाहन, सबसे लंबी दशा में। आनंद लें, पर ज़्यादा ख़र्च न करें।'),
    saturn: T('Hard work, responsibility and slow but lasting results. Patience and discipline are rewarded.', 'मेहनत, ज़िम्मेदारी, और धीमे पर टिकाऊ नतीजे। धैर्य और अनुशासन का फल मिलता है।'),
    rahu: T('Ambition, sudden changes, technology and foreign links. Big chances; stay grounded and honest.', 'महत्वाकांक्षा, अचानक बदलाव, तकनीक और विदेश से जुड़ाव। बड़े मौक़े; ज़मीन से जुड़े और ईमानदार रहें।'),
    ketu: T('Detachment, inner work and research. Let go of what is done; spiritual practice helps.', 'वैराग्य, भीतर का काम और शोध। जो बीत गया उसे छोड़ें; साधना मदद करती है।'),
  };
  const LUCKY = {
    sun: { num: 1, col: T('Orange and gold', 'नारंगी और सुनहरा'), gem: T('Ruby (Manik)', 'माणिक') },
    moon: { num: 2, col: T('White and silver', 'सफ़ेद और चाँदी'), gem: T('Pearl (Moti)', 'मोती') },
    mars: { num: 9, col: T('Red', 'लाल'), gem: T('Red coral (Moonga)', 'मूंगा') },
    mercury: { num: 5, col: T('Green', 'हरा'), gem: T('Emerald (Panna)', 'पन्ना') },
    jupiter: { num: 3, col: T('Yellow', 'पीला'), gem: T('Yellow sapphire (Pukhraj)', 'पुखराज') },
    venus: { num: 6, col: T('White and pink', 'सफ़ेद और गुलाबी'), gem: T('Diamond or opal', 'हीरा या ओपल') },
    saturn: { num: 8, col: T('Blue and black', 'नीला और काला'), gem: T('Blue sapphire (Neelam)', 'नीलम') },
  };
  const WEEKDAY_OF = { sun: 0, moon: 1, mars: 2, mercury: 3, jupiter: 4, venus: 5, saturn: 6 };

  const DOSHA = {
    mangal: {
      none: T('No Mangal dosha: Mars is not in the 1st, 2nd, 4th, 7th, 8th or 12th house from your lagna or Moon.', 'मंगल दोष नहीं: मंगल आपके लग्न या चंद्र से 1, 2, 4, 7, 8 या 12वें भाव में नहीं है।'),
      partial: T('Mild Mangal dosha: Mars sits in a Manglik house from one of your lagna or Moon, not both. Many jyotishis treat this as minor, and it often eases after 28.', 'हल्का मंगल दोष: मंगल लग्न या चंद्र में से एक से मांगलिक भाव में है, दोनों से नहीं। कई ज्योतिषी इसे हल्का मानते हैं, और यह अक्सर 28 के बाद कम हो जाता है।'),
      full: T('Mangal dosha: Mars is in a Manglik house from both your lagna and your Moon. Traditions suggest matching with another Manglik chart or a Mangal shanti puja before marriage.', 'मंगल दोष: मंगल लग्न और चंद्र, दोनों से मांगलिक भाव में है। परंपरा के अनुसार विवाह से पहले मांगलिक कुंडली से मिलान या मंगल शांति पूजा की जाती है।'),
    },
    kaalsarp: {
      yes: T('Kaal Sarp yoga: all seven planets sit on one side of the Rahu-Ketu axis. It is said to bring ups and downs and late but solid success; a Kaal Sarp puja is the usual remedy.', 'काल सर्प योग: सातों ग्रह राहु-केतु की धुरी के एक ही ओर हैं। कहते हैं इससे उतार-चढ़ाव आते हैं और सफलता देर से पर पक्की मिलती है; काल सर्प पूजा इसका आम उपाय है।'),
      no: T('No Kaal Sarp yoga: your planets sit on both sides of the Rahu-Ketu axis.', 'काल सर्प योग नहीं: आपके ग्रह राहु-केतु की धुरी के दोनों ओर हैं।'),
    },
    sadesati: [null,
      T('Sade Sati, first phase: Saturn passes the sign before your Moon. Expenses and sleep need care; slow down and plan.', 'साढ़े साती, पहला चरण: शनि आपकी चंद्र राशि से पहले वाली राशि में है। ख़र्च और नींद का ध्यान रखें; धीरे चलें और योजना बनाएँ।'),
      T('Sade Sati, peak phase: Saturn is over your Moon sign. Responsibility is heavy but it builds you; keep routines and be patient.', 'साढ़े साती, मध्य चरण: शनि आपकी चंद्र राशि पर है। ज़िम्मेदारी भारी है पर यह आपको मज़बूत बनाती है; दिनचर्या बनाए रखें और धैर्य रखें।'),
      T('Sade Sati, last phase: Saturn is in the sign after your Moon. Money and family matters settle as it ends.', 'साढ़े साती, अंतिम चरण: शनि आपकी चंद्र राशि के बाद वाली राशि में है। इसके ख़त्म होते-होते पैसे और परिवार के मामले सुलझते हैं।'),
    ],
    dhaiya: T('Shani dhaiya: Saturn is 4th or 8th from your Moon for about two and a half years. Keep health and paperwork in order.', 'शनि ढैया: शनि लगभग ढाई साल के लिए आपके चंद्र से चौथे या आठवें है। सेहत और कागज़ी काम ठीक रखें।'),
    nosadesati: T('No Sade Sati now: Saturn is not near your Moon sign.', 'अभी साढ़े साती नहीं: शनि आपकी चंद्र राशि के पास नहीं है।'),
  };

  // ── palm reading ──
  // Each feature: the choices (for the self-guided reading) and what each one means. The camera reading fills the same
  // features, so both ways give the same kind of reading.
  const PALM = {
    shape: {
      q: T('Look at your palm and fingers. Which is closest?', 'अपनी हथेली और उँगलियाँ देखिए। कौन-सा सबसे पास है?'),
      opts: {
        earth: { l: T('Square palm, short fingers', 'चौकोर हथेली, छोटी उँगलियाँ'), m: T('Earth hand: practical, steady and good with your hands. People trust you because you do what you say. Your stubborn streak is also your strength.', 'पृथ्वी हाथ: व्यावहारिक, स्थिर और हाथ के काम में कुशल। लोग आप पर भरोसा करते हैं क्योंकि आप जो कहते हैं वह करते हैं। आपकी ज़िद आपकी ताक़त भी है।') },
        air: { l: T('Square palm, long fingers', 'चौकोर हथेली, लंबी उँगलियाँ'), m: T('Air hand: curious, talkative and quick to think. You love ideas, people and learning; give your mind a rest now and then.', 'वायु हाथ: जिज्ञासु, बातूनी और तेज़ सोचने वाले। विचार, लोग और सीखना पसंद है; दिमाग़ को कभी-कभी आराम भी दें।') },
        fire: { l: T('Long palm, short fingers', 'लंबी हथेली, छोटी उँगलियाँ'), m: T('Fire hand: energetic, bold and quick to act. You lead by doing and get bored by delay; patience turns your spark into results.', 'अग्नि हाथ: ऊर्जावान, साहसी और तुरंत काम करने वाले। करके दिखाते हैं और देरी से ऊब जाते हैं; धैर्य आपकी चिंगारी को नतीजों में बदलता है।') },
        water: { l: T('Long palm, long fingers', 'लंबी हथेली, लंबी उँगलियाँ'), m: T('Water hand: sensitive, intuitive and creative. You read people well and feel deeply; guard your energy in crowds.', 'जल हाथ: संवेदनशील, अंतर्ज्ञानी और रचनात्मक। लोगों को अच्छी तरह समझते हैं और गहराई से महसूस करते हैं; भीड़ में अपनी ऊर्जा बचाएँ।') },
      },
    },
    heartEnd: {
      q: T('The heart line is the top line across your palm. Where does it end?', 'हृदय रेखा हथेली के ऊपर की आड़ी रेखा है। यह कहाँ ख़त्म होती है?'),
      opts: {
        jupiter: { l: T('Under the index finger', 'तर्जनी (पहली उँगली) के नीचे'), m: T('Your heart line reaches the index finger: you are idealistic in love, loyal, and you keep high standards for the people close to you.', 'आपकी हृदय रेखा तर्जनी तक जाती है: प्रेम में आदर्शवादी, वफ़ादार, और अपनों से ऊँची उम्मीदें रखने वाले।') },
        between: { l: T('Between the index and middle fingers', 'तर्जनी और मध्यमा के बीच'), m: T('Your heart line ends between the first two fingers: warm but sensible. You balance what you feel with what makes sense.', 'आपकी हृदय रेखा पहली दो उँगलियों के बीच ख़त्म होती है: गर्मजोशी भरे पर समझदार। जो महसूस करते हैं और जो सही है, दोनों में संतुलन रखते हैं।') },
        saturn: { l: T('Under the middle finger', 'मध्यमा (बीच की उँगली) के नीचे'), m: T('Your heart line stops under the middle finger: you show love through actions more than words, and you value your independence in relationships.', 'आपकी हृदय रेखा मध्यमा के नीचे रुकती है: प्यार शब्दों से ज़्यादा काम से जताते हैं, और रिश्तों में अपनी आज़ादी को महत्व देते हैं।') },
      },
    },
    heartShape: {
      q: T('Is your heart line curved or straight?', 'आपकी हृदय रेखा घुमावदार है या सीधी?'),
      opts: {
        curved: { l: T('Curves up towards the fingers', 'उँगलियों की ओर ऊपर मुड़ती है'), m: T('A curved heart line: you express feelings openly and warmly, and romance matters to you.', 'घुमावदार हृदय रेखा: भावनाएँ खुलकर और प्यार से जताते हैं, और रोमांस आपके लिए मायने रखता है।') },
        straight: { l: T('Runs fairly straight', 'लगभग सीधी चलती है'), m: T('A straight heart line: you are calm and private with feelings, and steady once you commit.', 'सीधी हृदय रेखा: भावनाओं में शांत और निजी, और एक बार जुड़ने पर स्थिर।') },
      },
    },
    headLen: {
      q: T('The head line runs across the middle of your palm. How long is it?', 'मस्तिष्क रेखा हथेली के बीच में आड़ी चलती है। यह कितनी लंबी है?'),
      opts: {
        long: { l: T('Long, almost to the far edge', 'लंबी, लगभग दूसरे किनारे तक'), m: T('A long head line: you think things through, plan ahead and enjoy many subjects.', 'लंबी मस्तिष्क रेखा: सोच-समझकर चलते हैं, आगे की योजना बनाते हैं और कई विषयों में रुचि रखते हैं।') },
        medium: { l: T('Medium, to below the ring finger', 'मध्यम, अनामिका के नीचे तक'), m: T('A medium head line: a balanced thinker, practical with a good dose of imagination.', 'मध्यम मस्तिष्क रेखा: संतुलित सोच, व्यावहारिक और अच्छी कल्पना के साथ।') },
        short: { l: T('Short, ends near the middle', 'छोटी, बीच में ही ख़त्म'), m: T('A short head line: quick and decisive, you like clear, practical results over long debate.', 'छोटी मस्तिष्क रेखा: तेज़ और निर्णायक, लंबी बहस से ज़्यादा साफ़ और व्यावहारिक नतीजे पसंद हैं।') },
      },
    },
    headSlope: {
      q: T('Does your head line run straight across or slope down?', 'आपकी मस्तिष्क रेखा सीधी जाती है या नीचे की ओर झुकती है?'),
      opts: {
        straight: { l: T('Straight across', 'सीधी आड़ी'), m: T('A straight head line: logical and realistic, good with numbers, systems and plans.', 'सीधी मस्तिष्क रेखा: तार्किक और यथार्थवादी, अंकों, व्यवस्था और योजनाओं में अच्छे।') },
        gentle: { l: T('Slopes down a little', 'थोड़ी नीचे झुकती है'), m: T('A gently sloping head line: you mix logic with imagination, which suits teaching, design and business.', 'हल्की झुकी मस्तिष्क रेखा: तर्क और कल्पना का मेल, जो पढ़ाने, डिज़ाइन और व्यापार में काम आता है।') },
        steep: { l: T('Slopes down a lot, towards the wrist', 'काफ़ी नीचे, कलाई की ओर'), m: T('A steeply sloping head line: a creative, imaginative mind. Art, writing and ideas come naturally to you.', 'तेज़ झुकी मस्तिष्क रेखा: रचनात्मक, कल्पनाशील मन। कला, लेखन और नए विचार आपको सहज आते हैं।') },
      },
    },
    headStart: {
      q: T('Where your thumb meets the palm: do the head and life lines start together?', 'जहाँ अँगूठा हथेली से मिलता है: क्या मस्तिष्क और जीवन रेखा साथ शुरू होती हैं?'),
      opts: {
        joined: { l: T('Yes, they start joined', 'हाँ, जुड़ी हुई शुरू होती हैं'), m: T('Head and life lines start together: you are careful, think before you leap, and family shaped your early choices.', 'मस्तिष्क और जीवन रेखा साथ शुरू होती हैं: सावधान, कूदने से पहले सोचते हैं, और शुरुआती फ़ैसलों पर परिवार का असर रहा।') },
        separate: { l: T('No, there is a gap', 'नहीं, बीच में जगह है'), m: T('A gap between head and life lines: independent and adventurous, you trusted your own judgement early.', 'मस्तिष्क और जीवन रेखा के बीच जगह: स्वतंत्र और साहसी, आपने जल्दी ही अपने फ़ैसलों पर भरोसा किया।') },
      },
    },
    lifeArc: {
      q: T('The life line curves around the base of your thumb. How wide is the curve?', 'जीवन रेखा अँगूठे के आधार के चारों ओर मुड़ती है। यह घुमाव कितना चौड़ा है?'),
      opts: {
        wide: { l: T('Wide, well into the palm', 'चौड़ा, हथेली के बीच तक'), m: T('A wide life line: lively, generous and full of energy; you enjoy people, movement and doing things.', 'चौड़ी जीवन रेखा: जीवंत, उदार और ऊर्जा से भरे; लोगों से मिलना, घूमना और काम करना पसंद है।') },
        medium: { l: T('Medium', 'मध्यम'), m: T('A balanced life line: steady energy, good at pacing yourself between work and rest.', 'संतुलित जीवन रेखा: स्थिर ऊर्जा, काम और आराम में अच्छा संतुलन।') },
        close: { l: T('Close to the thumb', 'अँगूठे के पास'), m: T('A life line close to the thumb: you save your energy for a small circle and prefer calm to crowds.', 'अँगूठे के पास जीवन रेखा: अपनी ऊर्जा कुछ ख़ास लोगों के लिए बचाते हैं और भीड़ से ज़्यादा शांति पसंद है।') },
      },
      note: T('Palm readers agree the length of the life line says nothing about how long you live; it shows your style of energy.', 'हस्तरेखा के जानकार मानते हैं कि जीवन रेखा की लंबाई से उम्र का पता नहीं चलता; यह आपकी ऊर्जा का स्वभाव दिखाती है।'),
    },
    lifeMarks: {
      q: T('Look along the life line. What do you see?', 'जीवन रेखा को ध्यान से देखिए। क्या दिखता है?'),
      opts: {
        none: { l: T('One clear, unbroken line', 'एक साफ़, बिना टूटी रेखा'), m: T('A clear life line: a steady path, with stamina to see things through.', 'साफ़ जीवन रेखा: स्थिर राह, और काम पूरा करने का दम।') },
        breaks: { l: T('A break or a jump', 'कहीं टूटी या खिसकी हुई'), m: T('A break in the life line: a big change of direction, such as a move, a new career or a fresh start.', 'जीवन रेखा में टूट: जीवन में बड़ा मोड़, जैसे नई जगह, नया करियर या नई शुरुआत।') },
        double: { l: T('A second line running beside it', 'साथ में एक दूसरी रेखा'), m: T('A sister line beside the life line: extra resilience and strong support from people around you.', 'जीवन रेखा के साथ सहायक रेखा: ज़्यादा मज़बूती और आसपास के लोगों से पक्का सहारा।') },
        chained: { l: T('Small chains or islands', 'छोटी जंजीर या द्वीप जैसे निशान'), m: T('Chains on the life line: stretches of stress; rest and routine keep you strong.', 'जीवन रेखा पर जंजीर: तनाव के दौर; आराम और नियमित दिनचर्या आपको मज़बूत रखती है।') },
      },
    },
    fate: {
      q: T('Is there a line running up the middle of your palm towards the middle finger?', 'क्या हथेली के बीच से मध्यमा की ओर ऊपर जाती कोई रेखा है?'),
      opts: {
        deep: { l: T('Yes, a clear one', 'हाँ, साफ़ दिखती है'), m: T('A clear fate line: a strong sense of direction. You know what you want from work and keep at it.', 'साफ़ भाग्य रेखा: दिशा का पक्का एहसास। आप जानते हैं काम से क्या चाहिए और उस पर टिके रहते हैं।') },
        faint: { l: T('Faint or in pieces', 'हल्की या टुकड़ों में'), m: T('A faint fate line: your path is shaped by your choices; you can change fields and do well in more than one.', 'हल्की भाग्य रेखा: आपकी राह आपके फ़ैसलों से बनती है; आप क्षेत्र बदल सकते हैं और एक से ज़्यादा में अच्छा कर सकते हैं।') },
        none: { l: T('No such line', 'ऐसी कोई रेखा नहीं'), m: T('No fate line: a free spirit. You carve your own path and aren\'t tied to one role or title.', 'भाग्य रेखा नहीं: आज़ाद मन। अपनी राह ख़ुद बनाते हैं, किसी एक पद या भूमिका से बँधे नहीं।') },
      },
    },
    sun: {
      q: T('Is there a line running up towards your ring finger?', 'क्या अनामिका (तीसरी उँगली) की ओर ऊपर जाती कोई रेखा है?'),
      opts: {
        clear: { l: T('Yes, a clear one', 'हाँ, साफ़'), m: T('A clear sun line: talent that gets noticed. Recognition and satisfaction come through what you create.', 'साफ़ सूर्य रेखा: ऐसा हुनर जो नज़र में आता है। आप जो बनाते हैं उससे पहचान और संतोष मिलता है।') },
        faint: { l: T('Faint', 'हल्की'), m: T('A faint sun line: a talent that grows with practice; keep showing your work.', 'हल्की सूर्य रेखा: ऐसा हुनर जो अभ्यास से बढ़ता है; अपना काम दिखाते रहें।') },
        none: { l: T('No', 'नहीं'), m: T('No sun line: success comes through steady work rather than the spotlight.', 'सूर्य रेखा नहीं: सफलता चमक-दमक से नहीं, लगातार मेहनत से आती है।') },
      },
    },
    bonds: {
      q: T('On the edge of your palm below the little finger: how many short side lines?', 'छोटी उँगली के नीचे हथेली के किनारे पर: कितनी छोटी आड़ी रेखाएँ हैं?'),
      opts: {
        '0': { l: T('None I can see', 'कोई नहीं दिखती'), m: T('No clear relationship lines: you keep matters of the heart private.', 'संबंध रेखा साफ़ नहीं: दिल की बातें आप निजी रखते हैं।') },
        '1': { l: T('One', 'एक'), m: T('One relationship line: one deep, lasting bond matters most to you.', 'एक संबंध रेखा: एक गहरा, लंबा रिश्ता आपके लिए सबसे अहम है।') },
        '2': { l: T('Two', 'दो'), m: T('Two relationship lines: two important bonds, or one that renews itself over time.', 'दो संबंध रेखाएँ: दो अहम रिश्ते, या एक रिश्ता जो समय के साथ फिर से नया होता है।') },
        '3': { l: T('Three or more', 'तीन या ज़्यादा'), m: T('Several relationship lines: warm and sociable, with many close bonds in your life.', 'कई संबंध रेखाएँ: मिलनसार और गर्मजोशी भरे, जीवन में कई क़रीबी रिश्ते।') },
      },
    },
    mount: {
      q: T('Which part of your palm is the most padded?', 'हथेली का कौन-सा हिस्सा सबसे उभरा हुआ है?'),
      opts: {
        venus: { l: T('The base of the thumb', 'अँगूठे का आधार'), m: T('A full mount of Venus: warmth, love of beauty, music and family.', 'उभरा शुक्र पर्वत: गर्मजोशी, सुंदरता, संगीत और परिवार से प्यार।') },
        jupiter: { l: T('Under the index finger', 'तर्जनी के नीचे'), m: T('A strong mount of Jupiter: ambition, leadership and a gift for guiding others.', 'उभरा गुरु पर्वत: महत्वाकांक्षा, नेतृत्व और दूसरों को राह दिखाने का गुण।') },
        saturn: { l: T('Under the middle finger', 'मध्यमा के नीचे'), m: T('A strong mount of Saturn: serious, responsible and drawn to research and deep work.', 'उभरा शनि पर्वत: गंभीर, ज़िम्मेदार और शोध व गहरे काम की ओर झुकाव।') },
        apollo: { l: T('Under the ring finger', 'अनामिका के नीचे'), m: T('A strong mount of the Sun: creative, charming and at ease in front of people.', 'उभरा सूर्य पर्वत: रचनात्मक, आकर्षक और लोगों के सामने सहज।') },
        mercury: { l: T('Under the little finger', 'छोटी उँगली के नीचे'), m: T('A strong mount of Mercury: a way with words, business sense and quick wit.', 'उभरा बुध पर्वत: बातों का जादू, व्यापार की समझ और तेज़ दिमाग़।') },
        moon: { l: T('The outer edge near the wrist', 'कलाई के पास बाहरी किनारा'), m: T('A full mount of the Moon: imagination, intuition and a love of travel and water.', 'उभरा चंद्र पर्वत: कल्पना, अंतर्ज्ञान, और यात्रा व पानी से लगाव।') },
      },
    },
    thumb: {
      q: T('Gently push your thumb back. Does it bend far?', 'अँगूठे को धीरे से पीछे दबाइए। क्या यह ज़्यादा मुड़ता है?'),
      opts: {
        flexible: { l: T('Yes, it bends back easily', 'हाँ, आसानी से मुड़ता है'), m: T('A flexible thumb: easy-going and generous, you adapt well to people and places.', 'लचीला अँगूठा: सहज और उदार, लोगों और जगहों के साथ अच्छे से ढल जाते हैं।') },
        firm: { l: T('No, it stays firm', 'नहीं, सख़्त रहता है'), m: T('A firm thumb: determined and reliable; once you decide, you follow through.', 'सख़्त अँगूठा: दृढ़ और भरोसेमंद; एक बार तय कर लिया तो पूरा करते हैं।') },
      },
    },
    fingers: {
      q: T('Compare your index and ring fingers. Which is longer?', 'तर्जनी और अनामिका की तुलना कीजिए। कौन लंबी है?'),
      opts: {
        index: { l: T('The index finger', 'तर्जनी'), m: T('A longer index finger: confident and self-directed, a natural organiser.', 'लंबी तर्जनी: आत्मविश्वासी और ख़ुद राह तय करने वाले, स्वाभाविक संगठक।') },
        equal: { l: T('About the same', 'लगभग बराबर'), m: T('Even index and ring fingers: balanced and diplomatic, a natural peacemaker.', 'बराबर तर्जनी और अनामिका: संतुलित और कूटनीतिक, स्वाभाविक रूप से मेल कराने वाले।') },
        ring: { l: T('The ring finger', 'अनामिका'), m: T('A longer ring finger: creative and willing to take chances; you enjoy a challenge.', 'लंबी अनामिका: रचनात्मक और जोखिम लेने को तैयार; चुनौती पसंद है।') },
      },
    },
  };
  // the order of the self-guided questions, and how the reading groups them
  const PALM_ORDER = ['shape', 'heartEnd', 'heartShape', 'headLen', 'headSlope', 'headStart', 'lifeArc', 'lifeMarks', 'fate', 'sun', 'bonds', 'mount', 'thumb', 'fingers'];
  const PALM_SECTIONS = [
    { id: 'nature', t: T('Your nature', 'आपका स्वभाव'), keys: ['shape', 'thumb', 'fingers'], note: 'overall' },
    { id: 'heart', t: T('Heart and love', 'दिल और प्रेम'), keys: ['heartEnd', 'heartShape', 'bonds'], note: 'heart' },
    { id: 'mind', t: T('Mind and talents', 'मन और प्रतिभा'), keys: ['headLen', 'headSlope', 'headStart', 'mount'], note: 'head' },
    { id: 'life', t: T('Energy and life path', 'ऊर्जा और जीवन की राह'), keys: ['lifeArc', 'lifeMarks'], note: 'life' },
    { id: 'work', t: T('Work and success', 'काम और सफलता'), keys: ['fate', 'sun'], note: 'fate' },
  ];

  const DISCLAIMER = T('Palmistry and astrology are traditions for reflection and fun, not science. Please don\'t make health, money or legal decisions from them.',
    'हस्तरेखा और ज्योतिष सोचने और आनंद की परंपराएँ हैं, विज्ञान नहीं। सेहत, पैसे या क़ानूनी फ़ैसले इनके आधार पर न लें।');

  return { SIGNS, SIGN_TRAIT, PLANETS, HOUSES, DIGNITY, NAKSHATRAS, TITHIS, AMAVASYA, PAKSHA, YOGAS, WEEKDAYS, GOCHAR, TARA, DASHA_TEXT, LUCKY, WEEKDAY_OF, DOSHA, PALM, PALM_ORDER, PALM_SECTIONS, DISCLAIMER };
});
