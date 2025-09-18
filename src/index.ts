import 'dotenv/config';

import { Client, GatewayIntentBits, Guild, GuildBasedChannel, GuildMember, Invite, Role, TextChannel, VoiceChannel } from 'discord.js';
import { query } from './database';
import apiApp, { setupApiRoutes } from './api';

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildInvites,
    ],
});

const inviteCache = new Map<string, Map<string, number>>(); // guildId -> (code -> uses)

async function populateGuildInvites(guildId: string) {
    try {
        const guild = await client.guilds.fetch(guildId);
        const invitesCollection = await guild.invites.fetch(); // requiere Manage Guild
        const map = new Map<string, number>();
        invitesCollection.forEach(inv => map.set(inv.code!, inv.uses ?? 0));
        inviteCache.set(guildId, map);
        console.log(`Cache de invites para ${guild.name} (${guildId}) populado. Total: ${map.size} invites.`);
    } catch (error) {
        console.error(`Error al poblar cache de invites para guild ${guildId}:`, error);
    }
}

client.once('ready', async () => {
    console.log(`Bot listo como ${client.user?.tag}`);
    if (process.env.GUILD_ID) {
        await populateGuildInvites(process.env.GUILD_ID);
    }
    setupApiRoutes(client);
    const port = process.env.PORT || 3000;
    apiApp.listen(port, () => console.log(`API http://localhost:${port}`));
});

client.on('inviteCreate', (invite) => {
    const gId = invite.guild?.id;
    if (!gId || !invite.code) return;
    if (!inviteCache.has(gId)) inviteCache.set(gId, new Map());
    inviteCache.get(gId)!.set(invite.code, invite.uses ?? 0);
    console.log(`Invite creado: ${invite.code} para guild ${gId}. Añadido al cache.`);
});

client.on('inviteDelete', (invite) => {
    const gId = invite.guild?.id;
    if (!gId || !invite.code) return;
    inviteCache.get(gId)?.delete(invite.code);
    console.log(`Invite borrado: ${invite.code} de guild ${gId}. Eliminado del cache.`);
});

client.on('guildMemberAdd', async (member) => {
    // Nuestro cache de invites *antes* de este evento de unión
    const oldInviteCache = inviteCache.get(member.guild.id) || new Map<string, number>();
    // Obtener los invites *actuales* de Discord después de la unión
    const newInvitesCollection = await member.guild.invites.fetch();

    let usedCode: string | null = null;
    let foundUsedInvite = false; // Bandera para asegurar que solo se identifique un invite

    // Paso 1: Buscar invites que incrementaron sus usos (para multi-uso o single-uso no eliminados aún)
    for (const [code, newInviteObject] of newInvitesCollection) { // newInviteObject es un objeto Invite aquí
        const oldUses = oldInviteCache.get(code) ?? 0;
        const newUses = newInviteObject.uses ?? 0;
        if (newUses > oldUses) {
            usedCode = code;
            foundUsedInvite = true;
            console.log(`Debug (guildMemberAdd): Invite ${code} aumentó usos. Antiguo: ${oldUses}, Nuevo: ${newUses}`);
            break; // Encontrado
        }
    }

    // Paso 2: Si no se encontró en el paso 1, buscar un invite de un solo uso que fue eliminado
    // Esto es crucial para los invites de un solo uso que desaparecen inmediatamente.
    if (!usedCode) { // Solo si no se encontró en el paso 1
        for (const [code, oldUses] of oldInviteCache) {
            // Si un invite estaba en nuestro cache antiguo pero ya no está en la colección recién fetched, 
            // significa que probablemente fue un invite de un solo uso que fue consumido y eliminado.
            if (!newInvitesCollection.has(code)) {
                usedCode = code;
                console.log(`Debug (guildMemberAdd): Invite ${code} estaba en el cache antiguo pero no en el nuevo (probablemente usado y eliminado).`);
                break;
            }
        }
    }

    // Fallback: Si todavía no se encontró un código de invitación (ej. por condición de carrera o escenario complejo de unión),
    // intentar encontrar el invite PENDING más reciente en nuestra BD que podría corresponder a esta unión.
    if (!usedCode) {
        try {
            const recentPendingInvite = await query(
                `SELECT invite_code FROM invites WHERE status = 'PENDING' ORDER BY created_at DESC LIMIT 1`,
                [] // Añadir el array de parámetros vacío
            );
            if (recentPendingInvite.rows.length > 0) {
                // Esta es una heurística. En un sistema real, idealmente coincidirías por ID de usuario desde OAuth2
                // o algún otro identificador. Para este escenario, es una "mejor estimación" de fallback.
                usedCode = recentPendingInvite.rows[0].invite_code;
                console.log(`Debug (guildMemberAdd): Fallback: Se encontró un invite PENDING reciente en la BD: ${usedCode}`);
            }
        } catch (dbError) {
            console.error(`Error en la búsqueda de fallback en la BD para el invite usado:`, dbError);
        }
    }

    // Actualizar el cache con el nuevo estado de los invites para este guild
    const currentInvitesMap = new Map<string, number>();
    newInvitesCollection.forEach(inv => currentInvitesMap.set(inv.code!, inv.uses ?? 0));
    inviteCache.set(member.guild.id, currentInvitesMap);

    // Logs para depuración del estado de los invites
    console.log('Debug (guildMemberAdd): Cache de Invites (antes de la unión):', Array.from(oldInviteCache.entries()).map(([code, uses]) => ({ code, uses })));
    console.log('Debug (guildMemberAdd): Invites actuales (después de la unión):', Array.from(newInvitesCollection.values()).map(inv => ({ code: inv.code, uses: inv.uses })));

    if (!usedCode) {
        console.log(`Miembro ${member.user.tag} se unió sin un código rastreable (URL vanity / re-unión).`);
        return;
    }

    console.log(`Miembro ${member.user.tag} se unió usando el invite: ${usedCode}`);

    // Screening: si pendiente, pospone la asignación de rol
    if (member.pending) {
        console.log(`Miembro ${member.user.tag} está pendiente (screening), posponiendo asignación de rol.`);
        // (opcional: guardar usedCode en una store temporal por userId para guildMemberUpdate)
        return;
    }

    await asignarRolPorInvite(member, usedCode);
});

// Si usas screening, asigna cuando pending -> false
client.on('guildMemberUpdate', async (oldMember, newMember) => {
    if (oldMember.pending && !newMember.pending) {
        console.log(`Miembro ${newMember.user.tag} ha completado el screening.`);
        // Por simplicidad, aquí re-intentaremos buscar el invite en la BD,
        // para un sistema más robusto, se debería guardar 'usedCode' de guildMemberAdd.
        // Dado que el invite es de 1 uso y ya fue detectado por guildMemberAdd,
        // podemos intentar buscar el invite más reciente PENDING/USED por el miembro.
        try {
            const latestInvite = await query(
                `SELECT invite_code, role_id FROM invites WHERE member_id = $1 OR (email = (SELECT email FROM invites WHERE member_id IS NULL AND invite_code IN (SELECT invite_code FROM invites WHERE status = 'PENDING' OR status = 'USED') ORDER BY created_at DESC LIMIT 1) AND status = 'PENDING') ORDER BY used_at DESC LIMIT 1`,
                [newMember.id]
            );

            if (latestInvite.rows.length > 0) {
                await asignarRolPorInvite(newMember, latestInvite.rows[0].invite_code);
            } else {
                console.log(`No se encontró invite rastreable para ${newMember.user.tag} después del screening.`);
            }
        } catch (error) {
            console.error(`Error al asignar rol post-screening a ${newMember.user.tag}:`, error);
        }
    }
});

async function asignarRolPorInvite(member: GuildMember, code: string) {
    console.log(`Intentando asignar rol para ${member.user.tag} con invite ${code}`);
    try {
        const result = await query(
            `SELECT role_id, email FROM invites WHERE invite_code = $1 AND status = 'PENDING'`,
            [code]
        );

        if (!result.rows.length) {
            console.log(`Invite ${code} no encontrado o ya usado/expirado en la base de datos para ${member.user.tag}.`);
            return;
        }

        const { role_id, email } = result.rows[0];
        const role = member.guild.roles.cache.get(role_id);

        if (!role) {
            console.warn(`Rol ${role_id} no existe o está por encima del bot en el servidor.`);
            return;
        }

        // Asegurarse de que el rol del bot sea más alto que el rol a asignar
        const botMember = await member.guild.members.fetch(client.user!.id);
        if (role.position >= botMember.roles.highest.position) {
            console.warn(`No se pudo asignar rol ${role.name} a ${member.user.tag}. El rol del bot es igual o inferior.`);
            return;
        }

        await member.roles.add(role);
        console.log(`Rol ${role.name} asignado a ${member.user.tag} (${email})`);

        await query(
            `UPDATE invites SET status='USED', used_at=$1, member_id=$2 WHERE invite_code=$3`,
            [new Date(), member.id, code]
        );
        console.log(`Estado del invite ${code} actualizado a USED.`);

    } catch (error) {
        console.error(`Error en asignarRolPorInvite para ${member.user.tag} con invite ${code}:`, error);
    }
}

client.login(process.env.DISCORD_BOT_TOKEN);

// testDbConnection se mantiene para depuración inicial
async function testDbConnection() {
    try {
        const res = await query('SELECT NOW()', []);
        console.log('Conexión a PostgreSQL exitosa:', res.rows[0]);
    } catch (err) {
        console.error('Error al conectar a PostgreSQL:', err);
    }
}

testDbConnection();
