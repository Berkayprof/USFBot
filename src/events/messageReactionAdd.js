import report from '../commands/Utility/modules/report.js';
import { getGuildConfig } from '../services/config/guildConfig.js';

export default {
    name: 'messageReactionAdd',
    async execute(reaction, user, client) {
        // Negeer reacties van bots
        if (user.bot) return;

        // Vul onvolledige data aan (partials)
        if (reaction.partial) {
            try { await reaction.fetch(); } catch { return; }
        }
        if (reaction.message.partial) {
            try { await reaction.message.fetch(); } catch { return; }
        }

        // Controleer of de emoji de rode cirkel is
        if (reaction.emoji.name !== '🔴') return;

        const message = reaction.message;
        if (!message.guild) return;

        // Haal de serverconfiguratie op
        const config = await getGuildConfig(message.guild.id);

        // Bouw een nep-interaction object zodat report.execute() denkt dat het een slash command is
        const mockInteraction = {
            guild: message.guild,
            channel: message.channel,
            user: user,
            member: await message.guild.members.fetch(user.id).catch(() => null),
            client: client,
            options: {
                getSubcommand: () => 'file',
                getUser: (name) => (name === 'user' ? message.author : null),
                getString: (name) => (name === 'reason' ? `Rapportage via 🔴 reactie op bericht: ${message.url}` : null),
            },
            // Zorg dat antwoorden van de report module in de DM van de melder terechtkomen
            reply: async (payload) => {
                try {
                    const dm = await user.createDM();
                    return await dm.send(payload);
                } catch {
                    // Mislukt als de gebruiker DMs uit heeft staan
                }
            },
            deferReply: async () => {},
            editReply: async (payload) => {
                try {
                    const dm = await user.createDM();
                    return await dm.send(payload);
                } catch {}
            },
            followUp: async (payload) => {
                try {
                    const dm = await user.createDM();
                    return await dm.send(payload);
                } catch {}
            },
            isReplied: false,
            deferred: false,
        };

        // Voer je bestaande report module uit
        await report.execute(mockInteraction, config, client);

        // Verwijder de 🔴 emoji van de gebruiker om opruim/duplicaat rapporten te voorkomen
        try {
            await reaction.users.remove(user.id);
        } catch {
            // Vereist 'Manage Messages' permissie op de bot
        }
    },
};