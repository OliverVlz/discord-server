import express from 'express';
import { Resend } from 'resend';
import { query } from './database';
import { Client, GatewayIntentBits, TextChannel, VoiceChannel } from 'discord.js';

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

const resend = new Resend(process.env.RESEND_API_KEY);

export const setupApiRoutes = (discordClient: Client) => {
    app.post('/generate-invite', async (req, res) => {
        const { email, roleId } = req.body;

        if (!email || !roleId) {
            return res.status(400).json({ error: 'Email y Role ID son requeridos.' });
        }

        try {
            // 1. Verificar si existe un invite PENDING para este email
            const existingInviteResult = await query(
                `SELECT invite_code, created_at FROM invites WHERE email = $1 AND status = 'PENDING'`,
                [email]
            );

            let existingInvite = existingInviteResult.rows[0];
            let inviteUrl = '';
            let newInviteCreated = false;

            if (existingInvite) {
                // Verificar si el invite existente aún es válido (no ha expirado)
                const inviteTTLSeconds = Number(process.env.INVITE_TTL_SECONDS || 86400);
                const createdAt = new Date(existingInvite.created_at);
                const expiresAt = new Date(createdAt.getTime() + inviteTTLSeconds * 1000);

                if (new Date() < expiresAt) {
                    // El invite existente todavía es válido
                    console.log(`Debug: Se encontró un invite PENDING válido para ${email}: ${existingInvite.invite_code}`);
                    inviteUrl = `https://discord.gg/${existingInvite.invite_code}`;
                } else {
                    // El invite existente ha expirado, marcar como EXPIRED y generar uno nuevo
                    console.log(`Debug: Invite PENDING para ${email} (${existingInvite.invite_code}) ha expirado. Marcando como EXPIRED.`);
                    await query(
                        `UPDATE invites SET status = 'EXPIRED' WHERE invite_code = $1`,
                        [existingInvite.invite_code]
                    );
                    existingInvite = null; // Para generar un nuevo invite
                }
            }

            if (!existingInvite) {
                // No hay invite pendiente válido, generar uno nuevo
                newInviteCreated = true;
                const guild = discordClient.guilds.cache.get(process.env.GUILD_ID as string);

                if (!guild) {
                    console.log(`Debug: Guild no encontrado con ID: ${process.env.GUILD_ID}`);
                    return res.status(500).json({ error: 'Servidor de Discord no encontrado.' });
                }

                console.log(`Debug: Guild encontrado: ${guild.name} (${guild.id})`);

                const channelId = process.env.DEFAULT_CHANNEL_ID as string; // Ahora lee del .env
                const channel = guild.channels.cache.get(channelId);

                if (!channel || (!channel.isTextBased() && !channel.isVoiceBased())) {
                    console.log(`Debug: Canal ${channel?.name || channelId} (${channel?.id || 'N/A'}) no es de texto ni de voz o no se encontró. Tipo: ${channel?.type || 'N/A'}`);
                    return res.status(500).json({ error: 'Canal inválido para invites (usa un canal público visible por @everyone).', debug: { channelId, channelType: channel?.type } });
                }

                const invitationalChannel = channel as TextChannel | VoiceChannel;

                const invite = await invitationalChannel.createInvite({
                    maxUses: 1,
                    maxAge: Number(process.env.INVITE_TTL_SECONDS || 86400), // 24h
                    temporary: false,
                    unique: true,
                    reason: `Invite para ${email} (rol ${roleId})`,
                });

                console.log(`Invite creado: code=${invite.code} guild=${invite.guild?.id} channel=${invite.channel?.id}`);

                if (!invite) {
                    return res.status(500).json({ error: 'No se pudo crear el invite de Discord. Asegúrate de que el bot tenga los permisos necesarios y el CHANNEL_ID_PARA_INVITES sea válido.' });
                }

                // Calcular expires_at
                const createdAt = new Date();
                const expiresAt = new Date(createdAt.getTime() + Number(process.env.INVITE_TTL_SECONDS || 86400) * 1000);

                // Guardar en la base de datos
                await query(
                    'INSERT INTO invites (invite_code, role_id, email, status, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6)',
                    [invite.code, roleId, email, 'PENDING', createdAt, expiresAt]
                );
                inviteUrl = invite.url;
            }

            // Enviar correo con Resend
            const { data, error } = await resend.emails.send({
                from: 'Acme <onboarding@resend.dev>', // Reemplaza con tu dominio verificado
                to: [email],
                subject: 'Tu invitación a nuestro servidor de Discord',
                html: `<strong>¡Hola!</strong><br><br>Has solicitado unirte a nuestro servidor de Discord. Aquí tienes tu enlace de invitación único:<br><a href="${inviteUrl}">${inviteUrl}</a><br><br>Este enlace es de un solo uso y te asignará el rol correcto automáticamente.<br><br>¡Te esperamos!`,
            });

            if (error) {
                console.error('Error al enviar el correo con Resend:', error);
                // No devolvemos un 500 aquí para no bloquear el flujo si el email es el problema de Resend
                return res.status(200).json({ message: 'Invite generado, pero error al enviar el correo.', error: error.message, inviteUrl });
            }

            console.log('Correo enviado:', data);
            res.status(200).json({ message: 'Invite generado y correo enviado exitosamente.', inviteUrl });

        } catch (error) {
            console.error('Error en el endpoint /generate-invite:', error);
            res.status(500).json({ error: 'Error interno del servidor.', details: (error as Error).message });
        }
    });
};

export default app;
