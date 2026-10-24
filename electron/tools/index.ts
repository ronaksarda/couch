// Every catalog tool maps to exactly one implementation. The compiler checks none is missing.
import type { ToolName } from '../policy';
import { deviceTools } from './devices';
import { fileTools } from './files';
import { localTools } from './local';
import { mediaTools } from './media';
import { scheduleTools } from './schedule';
import { screenTools } from './screen';
import type { Tool } from './rt';
import { webTools } from './web';

export const tools = { ...fileTools, ...webTools, ...mediaTools, ...localTools, ...scheduleTools, ...deviceTools, ...screenTools } as Record<ToolName, Tool<any>>;
