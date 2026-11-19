const config = require("../../../../config/config");
const cryptoHelper = require("../../../../helpers/crypto");

const P = config.get("configDatabase").prefix;
const TABLE = P + "contact_center_channel_webchat";
const SITES = P + "web_chat_sites";

// ── Тексти віджета за замовчуванням для всіх мов, які можна увімкнути ──
// Головна мова віджета — завжди англійська (en).
const PRIMARY_LOCALE = "en";

// h  — заголовок віджета; gw/go/ga — привітання (робоче / офлайн / підтвердження офлайн)
// sf/rl/nc — системні (помилка надсилання / забагато повідомлень / потрібен контакт)
// ld/lx/ip — інтерфейс (контакт залишено / форму згорнуто / плейсхолдер вводу)
// fn/fe/fp — підписи полів (ім'я / email / телефон); fs — кнопка форми; fk — дякуємо після форми
// fc — текст перед формою в робочий час; fo — офлайн; ft — оператор не відповів; fr — оцінка після закриття
const DEFAULT_TEXTS = {
	en: { h: "Chat with us", gw: "Hi! How can we help you?", go: "We are currently offline. Leave a message and we'll get back to you.", ga: "Thanks! We received your message and will reply during working hours.", sf: "Message not sent. Please try again.", rl: "Too many messages. Please wait a moment.", nc: "Please enter your email or phone number.", ld: "Thank you! Your contact details have been sent.", lx: "You can leave your contact details later.", ip: "Type a message…", fn: "Name", fe: "Email", fp: "Phone", fs: "Send", fk: "Thank you! We'll get back to you soon.", fc: "Leave your contact details so we can reach you.", fo: "We're offline now. Leave your contact details and we'll get back to you.", ft: "Our manager hasn't replied yet. Leave your contact details and we'll get back to you.", fr: "How would you rate this conversation?" },
	uk: { h: "Напишіть нам", gw: "Вітаємо! Чим можемо допомогти?", go: "Зараз ми не на зв'язку. Залиште повідомлення — ми відповімо.", ga: "Дякуємо! Ми отримали ваше повідомлення й відповімо в робочий час.", sf: "Повідомлення не надіслано. Спробуйте ще раз.", rl: "Забагато повідомлень. Зачекайте трохи.", nc: "Вкажіть email або телефон.", ld: "Дякуємо! Ваші контакти надіслано.", lx: "Контакти можна залишити пізніше.", ip: "Напишіть повідомлення…", fn: "Ім'я", fe: "Email", fp: "Телефон", fs: "Надіслати", fk: "Дякуємо! Ми скоро з вами зв'яжемося.", fc: "Залиште контакти, щоб ми могли з вами зв'язатися.", fo: "Зараз ми не на зв'язку. Залиште контакти — ми з вами зв'яжемося.", ft: "Менеджер ще не відповів. Залиште контакти — ми з вами зв'яжемося.", fr: "Як ви оцінюєте цю розмову?" },
	pl: { h: "Napisz do nas", gw: "Cześć! W czym możemy pomóc?", go: "Jesteśmy teraz offline. Zostaw wiadomość, a odpowiemy.", ga: "Dziękujemy! Otrzymaliśmy Twoją wiadomość i odpowiemy w godzinach pracy.", sf: "Wiadomość nie została wysłana. Spróbuj ponownie.", rl: "Za dużo wiadomości. Poczekaj chwilę.", nc: "Podaj e-mail lub numer telefonu.", ld: "Dziękujemy! Twoje dane kontaktowe zostały wysłane.", lx: "Dane kontaktowe możesz zostawić później.", ip: "Napisz wiadomość…", fn: "Imię", fe: "E-mail", fp: "Telefon", fs: "Wyślij", fk: "Dziękujemy! Wkrótce się odezwiemy.", fc: "Zostaw dane kontaktowe, abyśmy mogli się z Tobą skontaktować.", fo: "Jesteśmy teraz offline. Zostaw dane kontaktowe, a odezwiemy się.", ft: "Konsultant jeszcze nie odpowiedział. Zostaw dane kontaktowe, a odezwiemy się.", fr: "Jak oceniasz tę rozmowę?" },
	de: { h: "Schreiben Sie uns", gw: "Hallo! Wie können wir Ihnen helfen?", go: "Wir sind gerade offline. Hinterlassen Sie eine Nachricht, wir melden uns.", ga: "Danke! Wir haben Ihre Nachricht erhalten und antworten während der Geschäftszeiten.", sf: "Nachricht nicht gesendet. Bitte versuchen Sie es erneut.", rl: "Zu viele Nachrichten. Bitte warten Sie einen Moment.", nc: "Bitte geben Sie Ihre E-Mail oder Telefonnummer an.", ld: "Danke! Ihre Kontaktdaten wurden gesendet.", lx: "Sie können Ihre Kontaktdaten später hinterlassen.", ip: "Nachricht schreiben…", fn: "Name", fe: "E-Mail", fp: "Telefon", fs: "Senden", fk: "Danke! Wir melden uns in Kürze.", fc: "Hinterlassen Sie Ihre Kontaktdaten, damit wir Sie erreichen können.", fo: "Wir sind gerade offline. Hinterlassen Sie Ihre Kontaktdaten, wir melden uns.", ft: "Unser Mitarbeiter hat noch nicht geantwortet. Hinterlassen Sie Ihre Kontaktdaten, wir melden uns.", fr: "Wie bewerten Sie dieses Gespräch?" },
	fr: { h: "Écrivez-nous", gw: "Bonjour ! Comment pouvons-nous vous aider ?", go: "Nous sommes actuellement hors ligne. Laissez un message, nous vous répondrons.", ga: "Merci ! Nous avons reçu votre message et répondrons pendant nos heures d'ouverture.", sf: "Message non envoyé. Veuillez réessayer.", rl: "Trop de messages. Veuillez patienter un instant.", nc: "Veuillez indiquer votre e-mail ou votre numéro de téléphone.", ld: "Merci ! Vos coordonnées ont été envoyées.", lx: "Vous pourrez laisser vos coordonnées plus tard.", ip: "Écrivez un message…", fn: "Nom", fe: "E-mail", fp: "Téléphone", fs: "Envoyer", fk: "Merci ! Nous vous recontacterons rapidement.", fc: "Laissez vos coordonnées pour que nous puissions vous joindre.", fo: "Nous sommes hors ligne. Laissez vos coordonnées, nous vous recontacterons.", ft: "Notre conseiller n'a pas encore répondu. Laissez vos coordonnées, nous vous recontacterons.", fr: "Comment évaluez-vous cette conversation ?" },
	es: { h: "Escríbenos", gw: "¡Hola! ¿En qué podemos ayudarte?", go: "Ahora no estamos disponibles. Deja un mensaje y te responderemos.", ga: "¡Gracias! Hemos recibido tu mensaje y responderemos en horario laboral.", sf: "El mensaje no se ha enviado. Inténtalo de nuevo.", rl: "Demasiados mensajes. Espera un momento.", nc: "Indica tu correo electrónico o teléfono.", ld: "¡Gracias! Tus datos de contacto se han enviado.", lx: "Puedes dejar tus datos de contacto más tarde.", ip: "Escribe un mensaje…", fn: "Nombre", fe: "Correo electrónico", fp: "Teléfono", fs: "Enviar", fk: "¡Gracias! Nos pondremos en contacto contigo pronto.", fc: "Deja tus datos de contacto para que podamos comunicarnos contigo.", fo: "Ahora no estamos disponibles. Deja tus datos de contacto y te responderemos.", ft: "Nuestro agente aún no ha respondido. Deja tus datos de contacto y te responderemos.", fr: "¿Cómo valoras esta conversación?" },
	it: { h: "Scrivici", gw: "Ciao! Come possiamo aiutarti?", go: "Al momento non siamo disponibili. Lascia un messaggio e ti risponderemo.", ga: "Grazie! Abbiamo ricevuto il tuo messaggio e risponderemo in orario lavorativo.", sf: "Messaggio non inviato. Riprova.", rl: "Troppi messaggi. Attendi un momento.", nc: "Inserisci la tua email o il numero di telefono.", ld: "Grazie! I tuoi contatti sono stati inviati.", lx: "Puoi lasciare i tuoi contatti più tardi.", ip: "Scrivi un messaggio…", fn: "Nome", fe: "Email", fp: "Telefono", fs: "Invia", fk: "Grazie! Ti ricontatteremo presto.", fc: "Lascia i tuoi contatti per poter essere ricontattato.", fo: "Al momento non siamo disponibili. Lascia i tuoi contatti e ti ricontatteremo.", ft: "Il nostro operatore non ha ancora risposto. Lascia i tuoi contatti e ti ricontatteremo.", fr: "Come valuti questa conversazione?" },
	pt: { h: "Fale connosco", gw: "Olá! Como podemos ajudar?", go: "De momento estamos offline. Deixe uma mensagem e responderemos.", ga: "Obrigado! Recebemos a sua mensagem e responderemos no horário de funcionamento.", sf: "Mensagem não enviada. Tente novamente.", rl: "Demasiadas mensagens. Aguarde um momento.", nc: "Indique o seu e-mail ou número de telefone.", ld: "Obrigado! Os seus contactos foram enviados.", lx: "Pode deixar os seus contactos mais tarde.", ip: "Escreva uma mensagem…", fn: "Nome", fe: "E-mail", fp: "Telefone", fs: "Enviar", fk: "Obrigado! Entraremos em contacto em breve.", fc: "Deixe os seus contactos para que possamos falar consigo.", fo: "De momento estamos offline. Deixe os seus contactos e entraremos em contacto.", ft: "O nosso assistente ainda não respondeu. Deixe os seus contactos e entraremos em contacto.", fr: "Como avalia esta conversa?" },
	nl: { h: "Chat met ons", gw: "Hallo! Waarmee kunnen we je helpen?", go: "We zijn nu offline. Laat een bericht achter, dan reageren we.", ga: "Bedankt! We hebben je bericht ontvangen en reageren tijdens werktijden.", sf: "Bericht niet verzonden. Probeer het opnieuw.", rl: "Te veel berichten. Wacht even.", nc: "Vul je e-mailadres of telefoonnummer in.", ld: "Bedankt! Je contactgegevens zijn verzonden.", lx: "Je kunt je contactgegevens later achterlaten.", ip: "Typ een bericht…", fn: "Naam", fe: "E-mail", fp: "Telefoon", fs: "Verzenden", fk: "Bedankt! We nemen snel contact met je op.", fc: "Laat je contactgegevens achter, zodat we je kunnen bereiken.", fo: "We zijn nu offline. Laat je contactgegevens achter, dan nemen we contact op.", ft: "Onze medewerker heeft nog niet gereageerd. Laat je contactgegevens achter, dan nemen we contact op.", fr: "Hoe beoordeel je dit gesprek?" },
	cs: { h: "Napište nám", gw: "Dobrý den! Jak vám můžeme pomoci?", go: "Momentálně nejsme online. Zanechte zprávu a ozveme se.", ga: "Děkujeme! Vaši zprávu jsme obdrželi a odpovíme v pracovní době.", sf: "Zpráva nebyla odeslána. Zkuste to znovu.", rl: "Příliš mnoho zpráv. Chvíli počkejte.", nc: "Zadejte e-mail nebo telefon.", ld: "Děkujeme! Vaše kontaktní údaje byly odeslány.", lx: "Kontaktní údaje můžete zanechat později.", ip: "Napište zprávu…", fn: "Jméno", fe: "E-mail", fp: "Telefon", fs: "Odeslat", fk: "Děkujeme! Brzy se vám ozveme.", fc: "Zanechte kontaktní údaje, abychom se vám mohli ozvat.", fo: "Momentálně nejsme online. Zanechte kontaktní údaje a ozveme se.", ft: "Operátor zatím neodpověděl. Zanechte kontaktní údaje a ozveme se.", fr: "Jak hodnotíte tento rozhovor?" },
	sk: { h: "Napíšte nám", gw: "Dobrý deň! Ako vám môžeme pomôcť?", go: "Momentálne nie sme online. Zanechajte správu a ozveme sa.", ga: "Ďakujeme! Vašu správu sme dostali a odpovieme v pracovnom čase.", sf: "Správa nebola odoslaná. Skúste to znova.", rl: "Príliš veľa správ. Chvíľu počkajte.", nc: "Zadajte e-mail alebo telefón.", ld: "Ďakujeme! Vaše kontaktné údaje boli odoslané.", lx: "Kontaktné údaje môžete zanechať neskôr.", ip: "Napíšte správu…", fn: "Meno", fe: "E-mail", fp: "Telefón", fs: "Odoslať", fk: "Ďakujeme! Čoskoro sa vám ozveme.", fc: "Zanechajte kontaktné údaje, aby sme sa vám mohli ozvať.", fo: "Momentálne nie sme online. Zanechajte kontaktné údaje a ozveme sa.", ft: "Operátor zatiaľ neodpovedal. Zanechajte kontaktné údaje a ozveme sa.", fr: "Ako hodnotíte tento rozhovor?" },
	ro: { h: "Scrie-ne", gw: "Bună! Cu ce te putem ajuta?", go: "Momentan suntem offline. Lasă un mesaj și îți vom răspunde.", ga: "Mulțumim! Am primit mesajul tău și vom răspunde în timpul programului.", sf: "Mesajul nu a fost trimis. Încearcă din nou.", rl: "Prea multe mesaje. Te rugăm să aștepți puțin.", nc: "Introdu adresa de e-mail sau numărul de telefon.", ld: "Mulțumim! Datele tale de contact au fost trimise.", lx: "Poți lăsa datele de contact mai târziu.", ip: "Scrie un mesaj…", fn: "Nume", fe: "E-mail", fp: "Telefon", fs: "Trimite", fk: "Mulțumim! Te vom contacta în curând.", fc: "Lasă-ne datele de contact ca să te putem contacta.", fo: "Momentan suntem offline. Lasă-ne datele de contact și te vom contacta.", ft: "Consultantul nu a răspuns încă. Lasă-ne datele de contact și te vom contacta.", fr: "Cum evaluezi această conversație?" },
	bg: { h: "Пишете ни", gw: "Здравейте! С какво можем да помогнем?", go: "В момента не сме на линия. Оставете съобщение и ще ви отговорим.", ga: "Благодарим! Получихме съобщението ви и ще отговорим в работно време.", sf: "Съобщението не е изпратено. Опитайте отново.", rl: "Твърде много съобщения. Изчакайте малко.", nc: "Въведете имейл или телефон.", ld: "Благодарим! Данните ви за контакт са изпратени.", lx: "Можете да оставите данни за контакт по-късно.", ip: "Напишете съобщение…", fn: "Име", fe: "Имейл", fp: "Телефон", fs: "Изпрати", fk: "Благодарим! Скоро ще се свържем с вас.", fc: "Оставете данни за контакт, за да се свържем с вас.", fo: "В момента не сме на линия. Оставете данни за контакт и ще се свържем с вас.", ft: "Консултантът още не е отговорил. Оставете данни за контакт и ще се свържем с вас.", fr: "Как оценявате този разговор?" },
	hu: { h: "Írjon nekünk", gw: "Üdvözöljük! Miben segíthetünk?", go: "Jelenleg nem vagyunk elérhetők. Hagyjon üzenetet, és válaszolunk.", ga: "Köszönjük! Megkaptuk üzenetét, és munkaidőben válaszolunk.", sf: "Az üzenet nem lett elküldve. Próbálja újra.", rl: "Túl sok üzenet. Kérjük, várjon egy kicsit.", nc: "Adja meg e-mail-címét vagy telefonszámát.", ld: "Köszönjük! Elérhetőségeit elküldtük.", lx: "Elérhetőségeit később is megadhatja.", ip: "Írjon üzenetet…", fn: "Név", fe: "E-mail", fp: "Telefon", fs: "Küldés", fk: "Köszönjük! Hamarosan jelentkezünk.", fc: "Adja meg elérhetőségeit, hogy felvehessük Önnel a kapcsolatot.", fo: "Jelenleg nem vagyunk elérhetők. Adja meg elérhetőségeit, és jelentkezünk.", ft: "Munkatársunk még nem válaszolt. Adja meg elérhetőségeit, és jelentkezünk.", fr: "Hogyan értékeli ezt a beszélgetést?" },
	el: { h: "Γράψτε μας", gw: "Γεια σας! Πώς μπορούμε να βοηθήσουμε;", go: "Αυτή τη στιγμή δεν είμαστε διαθέσιμοι. Αφήστε μήνυμα και θα σας απαντήσουμε.", ga: "Ευχαριστούμε! Λάβαμε το μήνυμά σας και θα απαντήσουμε σε ώρες λειτουργίας.", sf: "Το μήνυμα δεν στάλθηκε. Δοκιμάστε ξανά.", rl: "Πάρα πολλά μηνύματα. Περιμένετε λίγο.", nc: "Συμπληρώστε email ή τηλέφωνο.", ld: "Ευχαριστούμε! Τα στοιχεία επικοινωνίας σας στάλθηκαν.", lx: "Μπορείτε να αφήσετε τα στοιχεία σας αργότερα.", ip: "Γράψτε ένα μήνυμα…", fn: "Όνομα", fe: "Email", fp: "Τηλέφωνο", fs: "Αποστολή", fk: "Ευχαριστούμε! Θα επικοινωνήσουμε σύντομα μαζί σας.", fc: "Αφήστε τα στοιχεία επικοινωνίας σας για να σας βρούμε.", fo: "Δεν είμαστε διαθέσιμοι τώρα. Αφήστε τα στοιχεία σας και θα επικοινωνήσουμε μαζί σας.", ft: "Ο συνεργάτης μας δεν απάντησε ακόμη. Αφήστε τα στοιχεία σας και θα επικοινωνήσουμε μαζί σας.", fr: "Πώς αξιολογείτε αυτή τη συνομιλία;" },
	tr: { h: "Bize yazın", gw: "Merhaba! Size nasıl yardımcı olabiliriz?", go: "Şu anda çevrimdışıyız. Mesaj bırakın, size geri döneceğiz.", ga: "Teşekkürler! Mesajınızı aldık, çalışma saatlerinde yanıtlayacağız.", sf: "Mesaj gönderilemedi. Lütfen tekrar deneyin.", rl: "Çok fazla mesaj. Lütfen biraz bekleyin.", nc: "Lütfen e-posta adresinizi veya telefon numaranızı girin.", ld: "Teşekkürler! İletişim bilgileriniz gönderildi.", lx: "İletişim bilgilerinizi daha sonra bırakabilirsiniz.", ip: "Bir mesaj yazın…", fn: "Ad", fe: "E-posta", fp: "Telefon", fs: "Gönder", fk: "Teşekkürler! En kısa sürede size dönüş yapacağız.", fc: "Size ulaşabilmemiz için iletişim bilgilerinizi bırakın.", fo: "Şu anda çevrimdışıyız. İletişim bilgilerinizi bırakın, size dönüş yapalım.", ft: "Temsilcimiz henüz yanıt vermedi. İletişim bilgilerinizi bırakın, size dönüş yapalım.", fr: "Bu görüşmeyi nasıl değerlendirirsiniz?" },
	sv: { h: "Chatta med oss", gw: "Hej! Hur kan vi hjälpa dig?", go: "Vi är offline just nu. Lämna ett meddelande så svarar vi.", ga: "Tack! Vi har tagit emot ditt meddelande och svarar under öppettiderna.", sf: "Meddelandet skickades inte. Försök igen.", rl: "För många meddelanden. Vänta en stund.", nc: "Ange din e-postadress eller ditt telefonnummer.", ld: "Tack! Dina kontaktuppgifter har skickats.", lx: "Du kan lämna dina kontaktuppgifter senare.", ip: "Skriv ett meddelande…", fn: "Namn", fe: "E-post", fp: "Telefon", fs: "Skicka", fk: "Tack! Vi hör av oss snart.", fc: "Lämna dina kontaktuppgifter så att vi kan nå dig.", fo: "Vi är offline just nu. Lämna dina kontaktuppgifter så hör vi av oss.", ft: "Vår medarbetare har inte svarat än. Lämna dina kontaktuppgifter så hör vi av oss.", fr: "Hur betygsätter du det här samtalet?" },
	da: { h: "Skriv til os", gw: "Hej! Hvordan kan vi hjælpe dig?", go: "Vi er offline lige nu. Efterlad en besked, så svarer vi.", ga: "Tak! Vi har modtaget din besked og svarer i åbningstiden.", sf: "Beskeden blev ikke sendt. Prøv igen.", rl: "For mange beskeder. Vent et øjeblik.", nc: "Angiv din e-mail eller dit telefonnummer.", ld: "Tak! Dine kontaktoplysninger er sendt.", lx: "Du kan efterlade dine kontaktoplysninger senere.", ip: "Skriv en besked…", fn: "Navn", fe: "E-mail", fp: "Telefon", fs: "Send", fk: "Tak! Vi kontakter dig snart.", fc: "Efterlad dine kontaktoplysninger, så vi kan kontakte dig.", fo: "Vi er offline lige nu. Efterlad dine kontaktoplysninger, så kontakter vi dig.", ft: "Vores medarbejder har ikke svaret endnu. Efterlad dine kontaktoplysninger, så kontakter vi dig.", fr: "Hvordan vurderer du denne samtale?" },
	fi: { h: "Kirjoita meille", gw: "Hei! Miten voimme auttaa?", go: "Emme ole juuri nyt paikalla. Jätä viesti, niin vastaamme.", ga: "Kiitos! Saimme viestisi ja vastaamme aukioloaikana.", sf: "Viestiä ei lähetetty. Yritä uudelleen.", rl: "Liian monta viestiä. Odota hetki.", nc: "Anna sähköpostiosoitteesi tai puhelinnumerosi.", ld: "Kiitos! Yhteystietosi on lähetetty.", lx: "Voit jättää yhteystietosi myöhemmin.", ip: "Kirjoita viesti…", fn: "Nimi", fe: "Sähköposti", fp: "Puhelin", fs: "Lähetä", fk: "Kiitos! Otamme sinuun pian yhteyttä.", fc: "Jätä yhteystietosi, jotta voimme ottaa sinuun yhteyttä.", fo: "Emme ole juuri nyt paikalla. Jätä yhteystietosi, niin otamme yhteyttä.", ft: "Asiakaspalvelijamme ei ole vielä vastannut. Jätä yhteystietosi, niin otamme yhteyttä.", fr: "Miten arvioisit tämän keskustelun?" },
	no: { h: "Skriv til oss", gw: "Hei! Hvordan kan vi hjelpe deg?", go: "Vi er frakoblet nå. Legg igjen en melding, så svarer vi.", ga: "Takk! Vi har mottatt meldingen din og svarer i åpningstiden.", sf: "Meldingen ble ikke sendt. Prøv igjen.", rl: "For mange meldinger. Vent litt.", nc: "Oppgi e-postadresse eller telefonnummer.", ld: "Takk! Kontaktinformasjonen din er sendt.", lx: "Du kan legge igjen kontaktinformasjon senere.", ip: "Skriv en melding…", fn: "Navn", fe: "E-post", fp: "Telefon", fs: "Send", fk: "Takk! Vi tar snart kontakt med deg.", fc: "Legg igjen kontaktinformasjonen din, så vi kan nå deg.", fo: "Vi er frakoblet nå. Legg igjen kontaktinformasjonen din, så tar vi kontakt.", ft: "Medarbeideren vår har ikke svart ennå. Legg igjen kontaktinformasjonen din, så tar vi kontakt.", fr: "Hvordan vurderer du denne samtalen?" },
	lt: { h: "Parašykite mums", gw: "Sveiki! Kuo galime padėti?", go: "Šiuo metu esame neprisijungę. Palikite žinutę ir mes atsakysime.", ga: "Ačiū! Gavome jūsų žinutę ir atsakysime darbo valandomis.", sf: "Žinutė neišsiųsta. Bandykite dar kartą.", rl: "Per daug žinučių. Palaukite akimirką.", nc: "Nurodykite el. paštą arba telefono numerį.", ld: "Ačiū! Jūsų kontaktai išsiųsti.", lx: "Kontaktus galite palikti vėliau.", ip: "Parašykite žinutę…", fn: "Vardas", fe: "El. paštas", fp: "Telefonas", fs: "Siųsti", fk: "Ačiū! Netrukus su jumis susisieksime.", fc: "Palikite kontaktus, kad galėtume su jumis susisiekti.", fo: "Šiuo metu esame neprisijungę. Palikite kontaktus ir mes susisieksime.", ft: "Konsultantas dar neatsakė. Palikite kontaktus ir mes susisieksime.", fr: "Kaip vertinate šį pokalbį?" },
	lv: { h: "Rakstiet mums", gw: "Sveiki! Kā varam palīdzēt?", go: "Pašlaik neesam tiešsaistē. Atstājiet ziņu, un mēs atbildēsim.", ga: "Paldies! Mēs saņēmām jūsu ziņu un atbildēsim darba laikā.", sf: "Ziņa netika nosūtīta. Mēģiniet vēlreiz.", rl: "Pārāk daudz ziņu. Lūdzu, uzgaidiet.", nc: "Norādiet e-pastu vai tālruni.", ld: "Paldies! Jūsu kontaktinformācija ir nosūtīta.", lx: "Kontaktinformāciju varat atstāt vēlāk.", ip: "Rakstiet ziņu…", fn: "Vārds", fe: "E-pasts", fp: "Tālrunis", fs: "Sūtīt", fk: "Paldies! Drīzumā ar jums sazināsimies.", fc: "Atstājiet kontaktinformāciju, lai mēs varētu ar jums sazināties.", fo: "Pašlaik neesam tiešsaistē. Atstājiet kontaktinformāciju, un mēs sazināsimies.", ft: "Konsultants vēl nav atbildējis. Atstājiet kontaktinformāciju, un mēs sazināsimies.", fr: "Kā jūs novērtējat šo sarunu?" },
	et: { h: "Kirjutage meile", gw: "Tere! Kuidas saame aidata?", go: "Oleme praegu võrguühenduseta. Jätke sõnum ja me vastame.", ga: "Aitäh! Saime teie sõnumi ja vastame tööajal.", sf: "Sõnumit ei saadetud. Proovige uuesti.", rl: "Liiga palju sõnumeid. Palun oodake hetk.", nc: "Sisestage e-post või telefoninumber.", ld: "Aitäh! Teie kontaktandmed on saadetud.", lx: "Kontaktandmed saate jätta hiljem.", ip: "Kirjutage sõnum…", fn: "Nimi", fe: "E-post", fp: "Telefon", fs: "Saada", fk: "Aitäh! Võtame teiega peagi ühendust.", fc: "Jätke oma kontaktandmed, et saaksime teiega ühendust võtta.", fo: "Oleme praegu võrguühenduseta. Jätke kontaktandmed ja võtame ühendust.", ft: "Klienditeenindaja pole veel vastanud. Jätke kontaktandmed ja võtame ühendust.", fr: "Kuidas hindate seda vestlust?" },
	sl: { h: "Pišite nam", gw: "Pozdravljeni! Kako vam lahko pomagamo?", go: "Trenutno nismo na voljo. Pustite sporočilo in odgovorili bomo.", ga: "Hvala! Vaše sporočilo smo prejeli in bomo odgovorili v delovnem času.", sf: "Sporočilo ni bilo poslano. Poskusite znova.", rl: "Preveč sporočil. Počakajte trenutek.", nc: "Vnesite e-pošto ali telefonsko številko.", ld: "Hvala! Vaši kontaktni podatki so bili poslani.", lx: "Kontaktne podatke lahko pustite pozneje.", ip: "Napišite sporočilo…", fn: "Ime", fe: "E-pošta", fp: "Telefon", fs: "Pošlji", fk: "Hvala! Kmalu vas bomo kontaktirali.", fc: "Pustite kontaktne podatke, da vas lahko pokličemo.", fo: "Trenutno nismo na voljo. Pustite kontaktne podatke in oglasili se bomo.", ft: "Svetovalec še ni odgovoril. Pustite kontaktne podatke in oglasili se bomo.", fr: "Kako ocenjujete ta pogovor?" },
	hr: { h: "Pišite nam", gw: "Pozdrav! Kako vam možemo pomoći?", go: "Trenutačno nismo dostupni. Ostavite poruku i odgovorit ćemo.", ga: "Hvala! Primili smo vašu poruku i odgovorit ćemo u radno vrijeme.", sf: "Poruka nije poslana. Pokušajte ponovno.", rl: "Previše poruka. Pričekajte trenutak.", nc: "Unesite e-poštu ili broj telefona.", ld: "Hvala! Vaši podaci za kontakt su poslani.", lx: "Podatke za kontakt možete ostaviti kasnije.", ip: "Napišite poruku…", fn: "Ime", fe: "E-pošta", fp: "Telefon", fs: "Pošalji", fk: "Hvala! Uskoro ćemo vam se javiti.", fc: "Ostavite podatke za kontakt kako bismo vam se mogli javiti.", fo: "Trenutačno nismo dostupni. Ostavite podatke za kontakt i javit ćemo vam se.", ft: "Savjetnik još nije odgovorio. Ostavite podatke za kontakt i javit ćemo vam se.", fr: "Kako ocjenjujete ovaj razgovor?" },
	sr: { h: "Pišite nam", gw: "Zdravo! Kako možemo da vam pomognemo?", go: "Trenutno nismo dostupni. Ostavite poruku i odgovorićemo.", ga: "Hvala! Primili smo vašu poruku i odgovorićemo u radno vreme.", sf: "Poruka nije poslata. Pokušajte ponovo.", rl: "Previše poruka. Sačekajte trenutak.", nc: "Unesite imejl ili broj telefona.", ld: "Hvala! Vaši kontakt podaci su poslati.", lx: "Kontakt podatke možete ostaviti kasnije.", ip: "Napišite poruku…", fn: "Ime", fe: "Imejl", fp: "Telefon", fs: "Pošalji", fk: "Hvala! Uskoro ćemo vam se javiti.", fc: "Ostavite kontakt podatke kako bismo vam se javili.", fo: "Trenutno nismo dostupni. Ostavite kontakt podatke i javićemo vam se.", ft: "Savetnik još nije odgovorio. Ostavite kontakt podatke i javićemo vam se.", fr: "Kako ocenjujete ovaj razgovor?" },
	ka: { h: "მოგვწერეთ", gw: "გამარჯობა! რით შეგვიძლია დაგეხმაროთ?", go: "ამჟამად ხაზზე არ ვართ. დაგვიტოვეთ შეტყობინება და გიპასუხებთ.", ga: "გმადლობთ! თქვენი შეტყობინება მივიღეთ და სამუშაო საათებში გიპასუხებთ.", sf: "შეტყობინება არ გაიგზავნა. სცადეთ ხელახლა.", rl: "ძალიან ბევრი შეტყობინებაა. ცოტა მოიცადეთ.", nc: "მიუთითეთ ელფოსტა ან ტელეფონის ნომერი.", ld: "გმადლობთ! თქვენი საკონტაქტო მონაცემები გაიგზავნა.", lx: "საკონტაქტო მონაცემების დატოვება მოგვიანებითაც შეგიძლიათ.", ip: "დაწერეთ შეტყობინება…", fn: "სახელი", fe: "ელფოსტა", fp: "ტელეფონი", fs: "გაგზავნა", fk: "გმადლობთ! მალე დაგიკავშირდებით.", fc: "დაგვიტოვეთ საკონტაქტო მონაცემები, რომ დაგიკავშირდეთ.", fo: "ამჟამად ხაზზე არ ვართ. დაგვიტოვეთ საკონტაქტო მონაცემები და დაგიკავშირდებით.", ft: "ოპერატორს ჯერ არ უპასუხია. დაგვიტოვეთ საკონტაქტო მონაცემები და დაგიკავშირდებით.", fr: "როგორ შეაფასებდით ამ საუბარს?" },
	az: { h: "Bizə yazın", gw: "Salam! Sizə necə kömək edə bilərik?", go: "Hazırda onlayn deyilik. Mesaj qoyun, sizə cavab verəcəyik.", ga: "Təşəkkür edirik! Mesajınızı aldıq və iş saatlarında cavab verəcəyik.", sf: "Mesaj göndərilmədi. Yenidən cəhd edin.", rl: "Həddən çox mesaj. Bir az gözləyin.", nc: "E-poçt ünvanınızı və ya telefon nömrənizi daxil edin.", ld: "Təşəkkür edirik! Əlaqə məlumatlarınız göndərildi.", lx: "Əlaqə məlumatlarınızı sonra da qoya bilərsiniz.", ip: "Mesaj yazın…", fn: "Ad", fe: "E-poçt", fp: "Telefon", fs: "Göndər", fk: "Təşəkkür edirik! Tezliklə sizinlə əlaqə saxlayacağıq.", fc: "Sizinlə əlaqə saxlaya bilməyimiz üçün əlaqə məlumatlarınızı qoyun.", fo: "Hazırda onlayn deyilik. Əlaqə məlumatlarınızı qoyun, sizinlə əlaqə saxlayacağıq.", ft: "Operatorumuz hələ cavab verməyib. Əlaqə məlumatlarınızı qoyun, sizinlə əlaqə saxlayacağıq.", fr: "Bu söhbəti necə qiymətləndirirsiniz?" },
	kk: { h: "Бізге жазыңыз", gw: "Сәлеметсіз бе! Қалай көмектесе аламыз?", go: "Қазір желіде емеспіз. Хабарлама қалдырыңыз, біз жауап береміз.", ga: "Рақмет! Хабарламаңызды алдық, жұмыс уақытында жауап береміз.", sf: "Хабарлама жіберілмеді. Қайталап көріңіз.", rl: "Хабарлама тым көп. Сәл күте тұрыңыз.", nc: "Электрондық пошта немесе телефон нөмірін көрсетіңіз.", ld: "Рақмет! Байланыс деректеріңіз жіберілді.", lx: "Байланыс деректерін кейінірек қалдыруға болады.", ip: "Хабарлама жазыңыз…", fn: "Аты", fe: "Электрондық пошта", fp: "Телефон", fs: "Жіберу", fk: "Рақмет! Жақын арада сізбен хабарласамыз.", fc: "Сізбен хабарласуымыз үшін байланыс деректеріңізді қалдырыңыз.", fo: "Қазір желіде емеспіз. Байланыс деректеріңізді қалдырыңыз, біз хабарласамыз.", ft: "Менеджер әлі жауап бермеді. Байланыс деректеріңізді қалдырыңыз, біз хабарласамыз.", fr: "Бұл әңгімені қалай бағалайсыз?" },
	ar: { h: "تواصل معنا", gw: "مرحبًا! كيف يمكننا مساعدتك؟", go: "نحن غير متصلين حاليًا. اترك رسالة وسنرد عليك.", ga: "شكرًا! استلمنا رسالتك وسنرد خلال ساعات العمل.", sf: "لم يتم إرسال الرسالة. يرجى المحاولة مرة أخرى.", rl: "رسائل كثيرة جدًا. يرجى الانتظار قليلًا.", nc: "يرجى إدخال بريدك الإلكتروني أو رقم هاتفك.", ld: "شكرًا! تم إرسال بيانات الاتصال الخاصة بك.", lx: "يمكنك ترك بيانات الاتصال لاحقًا.", ip: "اكتب رسالة…", fn: "الاسم", fe: "البريد الإلكتروني", fp: "الهاتف", fs: "إرسال", fk: "شكرًا! سنتواصل معك قريبًا.", fc: "اترك بيانات الاتصال لنتمكن من التواصل معك.", fo: "نحن غير متصلين حاليًا. اترك بيانات الاتصال وسنتواصل معك.", ft: "لم يرد موظفنا بعد. اترك بيانات الاتصال وسنتواصل معك.", fr: "كيف تقيّم هذه المحادثة؟" },
	he: { h: "כתבו לנו", gw: "שלום! איך נוכל לעזור?", go: "אנחנו לא זמינים כרגע. השאירו הודעה ונחזור אליכם.", ga: "תודה! קיבלנו את ההודעה שלכם ונשיב בשעות הפעילות.", sf: "ההודעה לא נשלחה. נסו שוב.", rl: "יותר מדי הודעות. המתינו רגע.", nc: "הזינו אימייל או מספר טלפון.", ld: "תודה! פרטי הקשר שלכם נשלחו.", lx: "אפשר להשאיר פרטי קשר מאוחר יותר.", ip: "כתבו הודעה…", fn: "שם", fe: "אימייל", fp: "טלפון", fs: "שליחה", fk: "תודה! נחזור אליכם בקרוב.", fc: "השאירו פרטי קשר כדי שנוכל לחזור אליכם.", fo: "אנחנו לא זמינים כרגע. השאירו פרטי קשר ונחזור אליכם.", ft: "הנציג שלנו עדיין לא ענה. השאירו פרטי קשר ונחזור אליכם.", fr: "איך תדרגו את השיחה הזו?" },
	zh: { h: "联系我们", gw: "您好！有什么可以帮您？", go: "我们目前不在线。请留言，我们会回复您。", ga: "谢谢！我们已收到您的消息，将在工作时间内回复。", sf: "消息发送失败，请重试。", rl: "消息过多，请稍候。", nc: "请填写您的邮箱或电话。", ld: "谢谢！您的联系方式已发送。", lx: "您可以稍后再留下联系方式。", ip: "输入消息…", fn: "姓名", fe: "邮箱", fp: "电话", fs: "发送", fk: "谢谢！我们会尽快与您联系。", fc: "请留下联系方式，方便我们与您联系。", fo: "我们目前不在线。请留下联系方式，我们会与您联系。", ft: "客服暂未回复。请留下联系方式，我们会与您联系。", fr: "您如何评价本次对话？" },
	ja: { h: "お問い合わせ", gw: "こんにちは！どのようなご用件でしょうか？", go: "現在対応時間外です。メッセージを残していただければ、折り返しご連絡します。", ga: "ありがとうございます！メッセージを受け付けました。営業時間内に返信いたします。", sf: "メッセージを送信できませんでした。もう一度お試しください。", rl: "メッセージが多すぎます。しばらくお待ちください。", nc: "メールアドレスまたは電話番号を入力してください。", ld: "ありがとうございます！連絡先を送信しました。", lx: "連絡先は後で入力することもできます。", ip: "メッセージを入力…", fn: "お名前", fe: "メールアドレス", fp: "電話番号", fs: "送信", fk: "ありがとうございます！まもなくご連絡します。", fc: "ご連絡のため、連絡先をご入力ください。", fo: "現在対応時間外です。連絡先をご入力いただければ、折り返しご連絡します。", ft: "担当者からまだ返信がありません。連絡先をご入力いただければ、折り返しご連絡します。", fr: "このチャットの評価をお願いします。" },
	ko: { h: "문의하기", gw: "안녕하세요! 무엇을 도와드릴까요?", go: "지금은 상담 시간이 아닙니다. 메시지를 남겨 주시면 답변드리겠습니다.", ga: "감사합니다! 메시지를 받았으며 상담 시간에 답변드리겠습니다.", sf: "메시지를 보내지 못했습니다. 다시 시도해 주세요.", rl: "메시지가 너무 많습니다. 잠시 기다려 주세요.", nc: "이메일 또는 전화번호를 입력해 주세요.", ld: "감사합니다! 연락처가 전송되었습니다.", lx: "연락처는 나중에 남기셔도 됩니다.", ip: "메시지를 입력하세요…", fn: "이름", fe: "이메일", fp: "전화번호", fs: "보내기", fk: "감사합니다! 곧 연락드리겠습니다.", fc: "연락드릴 수 있도록 연락처를 남겨 주세요.", fo: "지금은 상담 시간이 아닙니다. 연락처를 남겨 주시면 연락드리겠습니다.", ft: "상담원이 아직 답변하지 않았습니다. 연락처를 남겨 주시면 연락드리겠습니다.", fr: "이번 상담을 평가해 주세요." },
	hi: { h: "हमसे बात करें", gw: "नमस्ते! हम आपकी क्या मदद कर सकते हैं?", go: "हम अभी ऑफ़लाइन हैं। संदेश छोड़ें, हम जवाब देंगे।", ga: "धन्यवाद! हमें आपका संदेश मिल गया है, हम कार्य समय में जवाब देंगे।", sf: "संदेश नहीं भेजा गया। कृपया फिर से कोशिश करें।", rl: "बहुत अधिक संदेश। कृपया थोड़ा इंतज़ार करें।", nc: "कृपया अपना ईमेल या फ़ोन नंबर दर्ज करें।", ld: "धन्यवाद! आपकी संपर्क जानकारी भेज दी गई है।", lx: "आप संपर्क जानकारी बाद में भी दे सकते हैं।", ip: "संदेश लिखें…", fn: "नाम", fe: "ईमेल", fp: "फ़ोन", fs: "भेजें", fk: "धन्यवाद! हम जल्द ही आपसे संपर्क करेंगे।", fc: "अपनी संपर्क जानकारी छोड़ें ताकि हम आपसे संपर्क कर सकें।", fo: "हम अभी ऑफ़लाइन हैं। अपनी संपर्क जानकारी छोड़ें, हम आपसे संपर्क करेंगे।", ft: "हमारे प्रतिनिधि ने अभी तक जवाब नहीं दिया है। अपनी संपर्क जानकारी छोड़ें, हम आपसे संपर्क करेंगे।", fr: "आप इस बातचीत को कैसे रेट करेंगे?" },
	th: { h: "แชทกับเรา", gw: "สวัสดีค่ะ! มีอะไรให้เราช่วยไหมคะ?", go: "ขณะนี้เราออฟไลน์อยู่ ฝากข้อความไว้ แล้วเราจะติดต่อกลับ", ga: "ขอบคุณค่ะ! เราได้รับข้อความของคุณแล้ว และจะตอบกลับในเวลาทำการ", sf: "ส่งข้อความไม่สำเร็จ โปรดลองอีกครั้ง", rl: "ส่งข้อความมากเกินไป โปรดรอสักครู่", nc: "โปรดระบุอีเมลหรือเบอร์โทรศัพท์", ld: "ขอบคุณค่ะ! ส่งข้อมูลติดต่อของคุณแล้ว", lx: "คุณสามารถฝากข้อมูลติดต่อภายหลังได้", ip: "พิมพ์ข้อความ…", fn: "ชื่อ", fe: "อีเมล", fp: "โทรศัพท์", fs: "ส่ง", fk: "ขอบคุณค่ะ! เราจะติดต่อกลับโดยเร็ว", fc: "ฝากข้อมูลติดต่อไว้ เพื่อให้เราติดต่อกลับได้", fo: "ขณะนี้เราออฟไลน์อยู่ ฝากข้อมูลติดต่อไว้ แล้วเราจะติดต่อกลับ", ft: "เจ้าหน้าที่ยังไม่ได้ตอบกลับ ฝากข้อมูลติดต่อไว้ แล้วเราจะติดต่อกลับ", fr: "คุณให้คะแนนการสนทนานี้เท่าไร?" },
	vi: { h: "Trò chuyện với chúng tôi", gw: "Xin chào! Chúng tôi có thể giúp gì cho bạn?", go: "Hiện chúng tôi đang ngoại tuyến. Hãy để lại tin nhắn, chúng tôi sẽ phản hồi.", ga: "Cảm ơn bạn! Chúng tôi đã nhận được tin nhắn và sẽ trả lời trong giờ làm việc.", sf: "Không gửi được tin nhắn. Vui lòng thử lại.", rl: "Quá nhiều tin nhắn. Vui lòng đợi một chút.", nc: "Vui lòng nhập email hoặc số điện thoại.", ld: "Cảm ơn bạn! Thông tin liên hệ đã được gửi.", lx: "Bạn có thể để lại thông tin liên hệ sau.", ip: "Nhập tin nhắn…", fn: "Họ tên", fe: "Email", fp: "Điện thoại", fs: "Gửi", fk: "Cảm ơn bạn! Chúng tôi sẽ sớm liên hệ lại.", fc: "Hãy để lại thông tin liên hệ để chúng tôi có thể liên lạc với bạn.", fo: "Hiện chúng tôi đang ngoại tuyến. Hãy để lại thông tin liên hệ, chúng tôi sẽ liên lạc lại.", ft: "Nhân viên chưa trả lời. Hãy để lại thông tin liên hệ, chúng tôi sẽ liên lạc lại.", fr: "Bạn đánh giá cuộc trò chuyện này thế nào?" },
	id: { h: "Hubungi kami", gw: "Halo! Ada yang bisa kami bantu?", go: "Saat ini kami sedang offline. Tinggalkan pesan dan kami akan membalas.", ga: "Terima kasih! Pesan Anda sudah kami terima dan akan dibalas pada jam kerja.", sf: "Pesan tidak terkirim. Silakan coba lagi.", rl: "Terlalu banyak pesan. Mohon tunggu sebentar.", nc: "Masukkan email atau nomor telepon Anda.", ld: "Terima kasih! Kontak Anda telah terkirim.", lx: "Anda dapat meninggalkan kontak nanti.", ip: "Tulis pesan…", fn: "Nama", fe: "Email", fp: "Telepon", fs: "Kirim", fk: "Terima kasih! Kami akan segera menghubungi Anda.", fc: "Tinggalkan kontak Anda agar kami dapat menghubungi Anda.", fo: "Saat ini kami sedang offline. Tinggalkan kontak Anda dan kami akan menghubungi Anda.", ft: "Petugas kami belum membalas. Tinggalkan kontak Anda dan kami akan menghubungi Anda.", fr: "Bagaimana penilaian Anda untuk percakapan ini?" },
};

// Шлях у конфігу → ключ у DEFAULT_TEXTS
const TEXT_PATHS = {
	"appearance.headerTitle": "h",
	"greeting.working": "gw",
	"greeting.offline": "go",
	"greeting.offlineAck": "ga",
	"strings.sendFailed": "sf",
	"strings.rateLimited": "rl",
	"strings.leadNeedContact": "nc",
	"ui.leadDone": "ld",
	"ui.leadDismissed": "lx",
	"ui.inputPlaceholder": "ip",
	"triggers.autoForm.working.message": "fc",
	"triggers.onFirstMessage.working.message": "fc",
	"triggers.autoForm.offline.message": "fo",
	"triggers.onFirstMessage.offline.message": "fo",
	"triggers.onOperatorTimeout.message": "ft",
	"triggers.afterClose.review.message": "fr",
};
// Підписи полів форм за ключем поля (name) і тексти самої форми
const FIELD_TEXTS = { name: "fn", email: "fe", phone: "fp", tel: "fp" };
const FORM_TEXTS = { submitLabel: "fs", successText: "fk" };

const DEFAULT_FORM_ID = "contact";

function node(obj, path) {
	return path.split(".").reduce((o, k) => {
		if (!o[k] || typeof o[k] !== "object") o[k] = {};
		return o[k];
	}, obj);
}

/** Дописати тексти для мов codes лише там, де їх ще немає (заповнене вручну не чіпаємо) */
function fillTexts(cfg, codes) {
	const put = (map, key) => {
		codes.forEach((code) => {
			const t = DEFAULT_TEXTS[code] || DEFAULT_TEXTS[PRIMARY_LOCALE];
			if (!String(map[code] || "").trim()) map[code] = t[key];
		});
	};
	Object.keys(TEXT_PATHS).forEach((path) => put(node(cfg, path), TEXT_PATHS[path]));
	Object.values(cfg.forms || {}).forEach((f) => {
		(f.fields || []).forEach((fld) => {
			const key = FIELD_TEXTS[fld.name] || FIELD_TEXTS[fld.type];
			if (key) put(fld.label || (fld.label = {}), key);
		});
		Object.keys(FORM_TEXTS).forEach((k) => put(f[k] || (f[k] = {}), FORM_TEXTS[k]));
	});
	return cfg;
}

/** Конфіг нового веб-чату: англійська, форма «ім'я + email», тригери з текстами */
function defaultConfig() {
	const trigger = (enabled, afterSec) => ({ enabled, formId: DEFAULT_FORM_ID, afterSec, message: {} });
	const cfg = {
		version: 1,
		locales: { enabled: [PRIMARY_LOCALE], primary: PRIMARY_LOCALE },
		appearance: { position: "right", brandColor: "#16a34a", headerTitle: {} },
		greeting: {
			enabled: true,
			autoOpen: false,
			autoOpenDelaySec: 0,
			desktop: { autoOpen: false, sound: true },
			mobile: { autoOpen: false, sound: false },
			working: {},
			offline: {},
			offlineAck: {},
		},
		hours: {
			timezone: "Europe/Kyiv",
			force: "auto",
			schedule: { 1: [[9, 18]], 2: [[9, 18]], 3: [[9, 18]], 4: [[9, 18]], 5: [[9, 18]] },
			holidays: [],
		},
		forms: {
			[DEFAULT_FORM_ID]: {
				target: "lead",
				fields: [
					{ name: "name", type: "text", label: {}, required: true },
					{ name: "email", type: "email", label: {}, required: true },
				],
				requireAnyOf: ["email"],
			},
		},
		triggers: {
			autoForm: { working: trigger(false, 30), offline: trigger(false, 30) },
			// Офлайн — одразу після першого повідомлення просимо контакти
			onFirstMessage: { working: trigger(false, 0), offline: trigger(true, 0) },
			// Робочий час — якщо менеджер не відповів за хвилину
			onOperatorTimeout: trigger(true, 60),
			afterClose: { review: { enabled: false, message: {} } },
		},
		strings: {},
		ui: {},
	};
	return fillTexts(cfg, [PRIMARY_LOCALE]);
}

/** Головна мова — завжди англійська і завжди увімкнена */
function normalizeLocales(cfg) {
	const loc = cfg.locales || (cfg.locales = {});
	const enabled = Array.isArray(loc.enabled) ? loc.enabled.filter((c) => c !== PRIMARY_LOCALE) : [];
	loc.enabled = [PRIMARY_LOCALE].concat(enabled);
	loc.primary = PRIMARY_LOCALE;
	return cfg;
}

module.exports = {
	defaultConfig,
	fillTexts,
	code: "webchat",
	label: "contact_center.channels.type_webchat",
	icon: "fa-solid fa-globe",
	color: "#16a34a",
	view: "./types/webchat",
	table: TABLE,

	// ── Створення каналу ──
	// site_id — ідентифікатор, який віджет передає в data-site-id.
	// Рядок у web_chat_sites створюється одразу: без нього /chat/config
	// відхилить домен і віджет не стартує.
	async create(conn, idChannel) {
		const siteId = "s_" + cryptoHelper.random(12);

		const defaultCfg = defaultConfig();

		await conn.execute(`INSERT INTO ${SITES} (site_id, domains, active, config) VALUES (?, '', 0, CAST(? AS JSON))`, [siteId, JSON.stringify(defaultCfg)]);
		await conn.execute(`INSERT INTO ${TABLE} (id_channel, site_id) VALUES (?, ?)`, [idChannel, siteId]);
	},

	// ── Дані для сторінки налаштувань ──
	async load(conn, idChannel) {
		const [rows] = await conn.execute(
			`SELECT w.id, w.site_id,
                    s.domains, s.active AS site_active, s.config
             FROM ${TABLE} AS w
             LEFT JOIN ${SITES} AS s ON s.site_id = w.site_id
             WHERE w.id_channel = ? LIMIT 1`,
			[idChannel]
		);

		const r = rows[0] || {};

		// config — JSON з мовами, привітаннями, годинами, формами й тригерами.
		// Саме він є справжнім джерелом налаштувань віджета.
		let cfg = {};
		try {
			cfg = r.config ? (typeof r.config === "string" ? JSON.parse(r.config) : r.config) : {};
		} catch (e) {
			cfg = {};
		}

		// Тексти за замовчуванням — сторінка підставляє їх, коли вмикають нову мову
		return Object.assign({}, r, { config: cfg, has_token: true, defaults: { primary: PRIMARY_LOCALE, texts: DEFAULT_TEXTS, paths: TEXT_PATHS, fields: FIELD_TEXTS, forms: FORM_TEXTS } });
	},

	// ── Валідація ──
	validate(body) {
		const errors = [];

		const origins = String(body.allowed_origins || "").trim();
		if (!origins) {
			errors.push({ field: "allowed_origins", message: "Вкажіть хоча б один домен" });
		} else if (origins.length > 5000) {
			errors.push({ field: "allowed_origins", message: "Список доменів задовгий" });
		} else {
			const bad = origins
				.split(",")
				.map(function (d) {
					return d.trim();
				})
				.filter(function (d) {
					return d && !/^\*?\.?[a-z0-9.-]+\.[a-z]{2,}$/i.test(d);
				});

			if (bad.length) errors.push({ field: "allowed_origins", message: "Некоректний домен: " + bad[0] });
		}

		// Конфіг віджета валідує сам модуль веб-чату — там повний набір правил
		if (body.widget_config) {
			let cfg = null;

			try {
				cfg = typeof body.widget_config === "string" ? JSON.parse(body.widget_config) : body.widget_config;
			} catch (e) {
				errors.push({ field: "widget_config", message: "Конфіг не є коректним JSON" });
			}

			if (cfg) {
				const webchat = require("../../../../routes/contact-center/web-chat/web-chat");

				if (typeof webchat.validateConfig === "function") {
					const result = webchat.validateConfig(cfg);

					if (!result.ok) {
						result.errors.slice(0, 8).forEach(function (e) {
							errors.push({ field: "widget_config", message: e.path + ": " + e.message });
						});
					}
				}
			}
		}

		return { valid: errors.length === 0, errors: errors };
	},

	// ── Збереження ──
	async save(conn, idChannel, body) {
		const origins = String(body.allowed_origins || "")
			.split(",")
			.map(function (d) {
				return d.trim().toLowerCase();
			})
			.filter(Boolean)
			.join(",");

		// web_chat_sites.active керує тим, чи віджет узагалі відповідає
		const active = origins && body.status ? 1 : 0;

		await conn.execute(
			`UPDATE ${SITES} AS s
                INNER JOIN ${TABLE} AS w ON w.site_id = s.site_id
                SET s.domains = ?, s.active = ?
              WHERE w.id_channel = ?`,
			[origins, active, idChannel]
		);

		if (body.widget_config) {
			const cfg = normalizeLocales(typeof body.widget_config === "string" ? JSON.parse(body.widget_config) : body.widget_config);
			const json = JSON.stringify(cfg);

			await conn.execute(
				`UPDATE ${SITES} AS s
                    INNER JOIN ${TABLE} AS w ON w.site_id = s.site_id
                    SET s.config = CAST(? AS JSON)
                  WHERE w.id_channel = ?`,
				[json, idChannel]
			);

			// Скидаємо 60-секундний кеш конфігу, інакше зміни підхопляться із затримкою
			const [siteRows] = await conn.execute(`SELECT site_id FROM ${TABLE} WHERE id_channel = ? LIMIT 1`, [idChannel]);

			if (siteRows.length) {
				const webchat = require("../../../../routes/contact-center/web-chat/web-chat");
				if (typeof webchat.bustWidgetCfg === "function") webchat.bustWidgetCfg(siteRows[0].site_id);
			}
		}

		return { configured: !!origins, reload: false };
	},

	// ── Перевірка підключення ──
	async test(conn, idChannel) {
		const [rows] = await conn.execute(
			`SELECT w.site_id, s.domains, s.active
               FROM ${TABLE} AS w
               LEFT JOIN ${SITES} AS s ON s.site_id = w.site_id
              WHERE w.id_channel = ? LIMIT 1`,
			[idChannel]
		);

		const r = rows[0];
		if (!r || !r.site_id) return { ok: false, error: "site_id не згенеровано" };
		if (r.domains === null) return { ok: false, error: "Сайт віджета не знайдено в web_chat_sites" };
		if (!r.domains) return { ok: false, error: "Не вказано жодного дозволеного домену" };

		return { ok: true };
	},

	// ── Відправка повідомлення ──
	// Веб-чат не має зовнішнього API — доставка через socket namespace /webchat.
	// target тут дорівнює roomId ("<site_id>_<visitor_id>").
	async send(conn, idChannel, target, message) {
		const [rows] = await conn.execute(`SELECT site_id FROM ${TABLE} WHERE id_channel = ? LIMIT 1`, [idChannel]);

		const siteId = rows.length ? rows[0].site_id : null;
		if (!siteId) return { ok: false, error: "site_id каналу не задано" };

		// require усередині: модуль веб-чату тягне цей файл через реєстр каналів,
		// тому на верхньому рівні вийшла б циклічна залежність
		const webchat = require("../../../../routes/contact-center/web-chat/web-chat");

		if (typeof webchat.sendFromCrm !== "function") {
			return { ok: false, error: "Модуль веб-чату не підтримує відправку" };
		}

		const result = await webchat.sendFromCrm(siteId, target, message.text, message.id_manager);

		return result.ok ? { ok: true, source_id: "wc_" + result.id } : { ok: false, error: result.error };
	},

	// ── Прочитання менеджером ──
	// Прокидаємо у стару схему, щоб клієнт побачив другу галочку
	async onRead(conn, idChannel, target, idManager) {
		const [rows] = await conn.execute(`SELECT site_id FROM ${TABLE} WHERE id_channel = ? LIMIT 1`, [idChannel]);

		const siteId = rows.length ? rows[0].site_id : null;
		if (!siteId) return;

		const webchat = require("../../../../routes/contact-center/web-chat/web-chat");
		if (typeof webchat.markReadFromCrm !== "function") return;

		await webchat.markReadFromCrm(siteId, target, idManager);
	},

	// ── Ідентифікатор у списку каналів ──
	identitySql(alias) {
		return `COALESCE(${alias}.site_id, '')`;
	},
};