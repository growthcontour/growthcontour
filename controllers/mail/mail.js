"use strict";

const nodemailer = require("nodemailer");
const config     = require("../../config/config");
const configMail = config.get("configMail");
const logging    = require("../../logging/logging");

// ─── Транспорт ───────────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
    host:   configMail.host,
    port:   configMail.port,
    secure: configMail.secure,
    auth: {
        user: configMail.user,
        pass: configMail.pass,
    },
    tls: {
        rejectUnauthorized: false,
    },
});

/**
 * Інвайт — юзер сам заповнить дані і пароль.
 */
async function sendInviteEmail(email, token, invitedBy) {
    try {
        const configServer = config.get("configServer");
        const link = `${configServer.url}/register/${token}`;

        await transporter.sendMail({
            from:    `"${configMail.from_name}" <${configMail.from_email}>`,
            to:      email,
            subject: "Запрошення до системи Growth Contour",
            html: `
                <div style="font-family:Arial,sans-serif; max-width:600px; margin:0 auto;">
                    <h2 style="color:#0d6efd;">Growth Contour</h2>
                    <p>
                        Користувач <strong>${invitedBy.first_name} ${invitedBy.last_name}</strong>
                        запросив вас приєднатись до системи.
                    </p>
                    <p>Для завершення реєстрації натисніть кнопку нижче:</p>
                    <a href="${link}"
                       style="display:inline-block; padding:12px 28px; background:#0d6efd;
                              color:#fff; text-decoration:none; font-size:15px;">
                        Завершити реєстрацію
                    </a>
                    <p style="margin-top:24px; color:#888; font-size:12px;">
                        Посилання дійсне 24 години.<br>
                        Якщо ви не очікували цього листа — проігноруйте його.
                    </p>
                </div>
            `,
        });

    } catch (error) {
        logging.error("[sendInviteEmail]", error);
        throw error;
    }
}

/**
 * Ручне додавання — адмін вказав пароль вручну і хоче надіслати його юзеру.
 */
async function sendPasswordEmail(email, password, firstName, lastName, createdBy) {
    try {
        const configServer = config.get("configServer");

        await transporter.sendMail({
            from:    `"${configMail.from_name}" <${configMail.from_email}>`,
            to:      email,
            subject: "Ваш акаунт створено — Growth Contour",
            html: `
                <div style="font-family:Arial,sans-serif; max-width:600px; margin:0 auto;">
                    <h2 style="color:#0d6efd;">Growth Contour</h2>
                    <p>Вітаємо, <strong>${firstName} ${lastName}</strong>!</p>
                    <p>
                        Адміністратор <strong>${createdBy.first_name} ${createdBy.last_name}</strong>
                        створив для вас акаунт у системі.
                    </p>
                    <table style="border-collapse:collapse; width:100%; margin-bottom:16px;">
                        <tr>
                            <td style="padding:8px; border:1px solid #dee2e6; background:#f8f9fa; width:120px;">
                                <strong>Email</strong>
                            </td>
                            <td style="padding:8px; border:1px solid #dee2e6;">${email}</td>
                        </tr>
                        <tr>
                            <td style="padding:8px; border:1px solid #dee2e6; background:#f8f9fa;">
                                <strong>Пароль</strong>
                            </td>
                            <td style="padding:8px; border:1px solid #dee2e6;">${password}</td>
                        </tr>
                    </table>
                    <a href="${configServer.url}/login/"
                       style="display:inline-block; padding:12px 28px; background:#0d6efd;
                              color:#fff; text-decoration:none; font-size:15px;">
                        Увійти в систему
                    </a>
                </div>
            `,
        });

    } catch (error) {
        logging.error("[sendPasswordEmail]", error);
        throw error;
    }
}

async function sendAccountActivatedEmail(email, invitedBy) {
  try {
    // 1) HTML-шаблон. Якщо у тебе шаблони через emailUtils — використай його.
    //    ВАЖЛИВО: у тілі листа НЕ має бути пароля. Лише факт активації + посилання на /login.
    const htmlTemplate = emailUtils.getEmailTemplate("account-activated", {
      loginURL: `${configServer.base_url}/login`,
    });

    // 2) Транспорт — той самий, що в sendInviteEmail (не дублюй конфіг, винеси в спільну функцію, якщо є).
    const transporter = nodemailer.createTransport({
      host: configMail.host,
      port: configMail.port,
      secure: configMail.secure,
      auth: { user: configMail.user, pass: configMail.password },
    });

    // 3) Лист
    const mailOptions = {
      from: `"${configMail.from_name}" <${configMail.from_email}>`,
      to: email,
      subject: "Ваш акаунт активовано",
      html: htmlTemplate,
    };

    await transporter.sendMail(mailOptions);
    logging.info(`Лист про активацію надіслано на: ${email}`);
  } catch (error) {
    logging.error(`Помилка надсилання листа про активацію: ${error}`);
    throw error;
  }
}

const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/**
 * Підтвердження нової адреси email (посилання дійсне 24 години).
 */
async function sendEmailChangeConfirm(email, token) {
    const configServer = config.get("configServer");
    const link = `${configServer.url}/users/email/confirm/${token}`;

    await transporter.sendMail({
        from:    `"${configMail.from_name}" <${configMail.from_email}>`,
        to:      email,
        subject: "Підтвердіть нову адресу email — Growth Contour",
        html: `
            <div style="font-family:Arial,sans-serif; max-width:600px; margin:0 auto;">
                <h2 style="color:#0d6efd;">Growth Contour</h2>
                <p>Цю адресу вказали як новий email для входу в систему.</p>
                <p>Щоб підтвердити зміну, натисніть кнопку нижче:</p>
                <a href="${link}"
                   style="display:inline-block; padding:12px 28px; background:#0d6efd;
                          color:#fff; text-decoration:none; font-size:15px;">
                    Підтвердити email
                </a>
                <p style="margin-top:24px; color:#888; font-size:12px;">
                    Посилання дійсне 24 години.<br>
                    Якщо ви не змінювали email — проігноруйте цей лист, адреса не зміниться.
                </p>
            </div>
        `,
    });
}

/**
 * Повідомлення на стару адресу про зміну email.
 */
async function sendEmailChangeNotice(oldEmail, newEmail) {
    await transporter.sendMail({
        from:    `"${configMail.from_name}" <${configMail.from_email}>`,
        to:      oldEmail,
        subject: "Зміна email вашого акаунта — Growth Contour",
        html: `
            <div style="font-family:Arial,sans-serif; max-width:600px; margin:0 auto;">
                <h2 style="color:#0d6efd;">Growth Contour</h2>
                <p>Для вашого акаунта запитано зміну email на <strong>${escHtml(newEmail)}</strong>.</p>
                <p style="color:#dc3545;">
                    Якщо це були не ви — негайно змініть пароль і завершіть усі сесії
                    на сторінці профілю, або зверніться до адміністратора.
                </p>
            </div>
        `,
    });
}

module.exports = { sendInviteEmail, sendAccountActivatedEmail, sendPasswordEmail, sendEmailChangeConfirm, sendEmailChangeNotice };