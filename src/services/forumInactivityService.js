import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } from 'discord.js';
import { getGuildConfig } from './config/guildConfig.js';
import { resolveForumThread } from '../commands/Utility/forum.js';

const INACTIVITY_CHECK_INTERVAL = 15 * 60 * 1000; // Elke 15 minuten
const FORTY_EIGHT_HOURS = 48 * 60 * 60 * 1000;
const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

export function startForumInactivityChecker(client) {
    setInterval(() => checkForumInactivity(client), INACTIVITY_CHECK_INTERVAL);
    // Eerste controle direct bij opstarten
    checkForumInactivity(client);
}

async function checkForumInactivity(client) {
    for (const guild of client.guilds.cache.values()) {
        try {
            const config = await getGuildConfig(client, guild.id);
            const managedChannels = config.forumManagement?.channels || [];

            if (!managedChannels.length) continue;

            for (const channelId of managedChannels) {
                const channel = await guild.channels.fetch(channelId).catch(() => null);
                if (!channel || channel.type !== ChannelType.GuildForum) continue;

                // Haal alle actieve threads op
                const activeThreads = await channel.threads.fetchActive();

                for (const thread of activeThreads.threads.values()) {
                    // Negeer gelockte posts
                    if (thread.locked) continue;

                    await processThreadInactivity(thread);
                }
            }
        } catch (error) {
            console.error(`Fout bij forum inactiviteitscontrole in guild ${guild.id}:`, error);
        }
    }
}

async function processThreadInactivity(thread) {
    try {
        const messages = await thread.messages.fetch({ limit: 1 });
        const lastMessage = messages.first();
        if (!lastMessage) return;

        const now = Date.now();
        const timeSinceLastMsg = now - lastMessage.createdTimestamp;

        const isPromptMessage = lastMessage.author.id === thread.client.user.id && 
                                lastMessage.embeds.length > 0 && 
                                lastMessage.embeds[0].title === 'Inactive Forum Post';

        // SITUATIE 1: Het laatste bericht is de bot-prompt en er is 24 uur niet gereageerd -> Auto Lock
        if (isPromptMessage) {
            if (timeSinceLastMsg >= TWENTY_FOUR_HOURS) {
                await thread.setLocked(true);
                await thread.send('# Locked - Inactive\nThis post was automatically locked because there was no response to the inactivity check within 24 hours.');
            }
            return;
        }

        // SITUATIE 2: Het laatste bericht is een gewoon bericht en er is 48 uur geen activiteit -> Stuur prompt
        if (timeSinceLastMsg >= FORTY_EIGHT_HOURS) {
            const embed = new EmbedBuilder()
                .setTitle('Inactive Forum Post')
                .setDescription('Hello, this post seems to be inactive. Has your issue been solved?')
                .setFooter({ text: 'Selecting No resets the 24-hour inactivity timer.' })
                .setTimestamp(lastMessage.createdTimestamp)
                .setColor('#E67E22'); // Oranje accentkleur

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`forum_solved_${thread.id}`)
                    .setLabel('Yes, my issue has been solved')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`forum_not_solved_${thread.id}`)
                    .setLabel("No, it hasn't")
                    .setStyle(ButtonStyle.Secondary)
            );

            await thread.send({
                content: `<@${thread.ownerId}>`,
                embeds: [embed],
                components: [row]
            });
        }
    } catch (err) {
        console.error(`Fout bij verwerken van thread ${thread.id}:`, err);
    }
}