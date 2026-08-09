import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import { patchGuildConfig, getGuildConfig } from '../../services/config/guildConfig.js';

export default {
    data: new SlashCommandBuilder()
        .setName('forum')
        .setDescription('Forum management instellingen')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
        .addSubcommand(sub =>
            sub.setName('setup')
               .setDescription('Voeg een forumkanaal toe of verwijder deze voor inactiviteitscontrole')
               .addChannelOption(opt =>
                   opt.setName('channel')
                      .setDescription('Het forumkanaal')
                      .addChannelTypes(ChannelType.GuildForum)
                      .setRequired(true)
               )
        )
        .addSubcommand(sub =>
            sub.setName('solved')
               .setDescription('Markeer de huidige forum post als opgelost')
        )
        .addSubcommand(sub =>
            sub.setName('resolved')
               .setDescription('Markeer de huidige forum post als opgelost')
        ),

    async execute(interaction, client) {
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'setup') {
            const channel = interaction.options.getChannel('channel');
            const config = await getGuildConfig(client, interaction.guildId);
            
            let forumChannels = config.forumManagement?.channels || [];
            
            if (forumChannels.includes(channel.id)) {
                forumChannels = forumChannels.filter(id => id !== channel.id);
                await patchGuildConfig(client, interaction.guildId, {
                    forumManagement: { channels: forumChannels }
                });
                return await interaction.reply({
                    content: `✅ Forumkanaal ${channel} is **verwijderd** uit het inactiviteitsbeheer.`,
                    ephemeral: true
                });
            } else {
                forumChannels.push(channel.id);
                await patchGuildConfig(client, interaction.guildId, {
                    forumManagement: { channels: forumChannels }
                });
                return await interaction.reply({
                    content: `✅ Forumkanaal ${channel} is **toegevoegd** aan het inactiviteitsbeheer.`,
                    ephemeral: true
                });
            }
        }

        if (subcommand === 'solved' || subcommand === 'resolved') {
            const thread = interaction.channel;
            if (!thread.isThread() || thread.parent?.type !== ChannelType.GuildForum) {
                return await interaction.reply({
                    content: '❌ Dit commando kan alleen binnen een forum-post worden gebruikt.',
                    ephemeral: true
                });
            }

            // Controleer of de gebruiker de auteur is of moderator-rechten heeft
            const isOwner = thread.ownerId === interaction.user.id;
            const isMod = interaction.member.permissions.has(PermissionFlagsBits.ManageThreads);

            if (!isOwner && !isMod) {
                return await interaction.reply({
                    content: '❌ Alleen de maker van de post of een moderator kan dit commando gebruiken.',
                    ephemeral: true
                });
            }

            await interaction.reply({ content: '🔒 Post wordt opgelost en vergrendeld...' });
            await resolveForumThread(thread);
        }
    }
};

/**
 * Hulpfunctie om een thread te markeren als opgelost, tag toe te voegen en te locken.
 */
export async function resolveForumThread(thread) {
    try {
        // Tag "Solved" of "Resolved" zoeken en toevoegen indien aanwezig
        const parent = thread.parent;
        if (parent?.availableTags?.length > 0) {
            const resolvedTag = parent.availableTags.find(tag => 
                tag.name.toLowerCase().includes('solved') || tag.name.toLowerCase().includes('resolved')
            );

            if (resolvedTag && !thread.appliedTags.includes(resolvedTag.id)) {
                await thread.setAppliedTags([...thread.appliedTags, resolvedTag.id]).catch(() => null);
            }
        }

        // Lock de thread
        await thread.setLocked(true);

        // Bericht sturen
        await thread.send('# Locked - Resolved\nThis post has been resolved.');
    } catch (error) {
        console.error('Fout bij het oplossen van forum thread:', error);
    }
}