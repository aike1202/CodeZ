const fs = require('fs')
const file = 'src/main/agent/AgentRunner/index.ts'
let code = fs.readFileSync(file, 'utf8')

code = code.replace("import { handlePlanModeTool } from './planRunnerHelper'", "import { handlePlanModeTool } from './planRunnerHelper'\nimport { handleTaskTool } from './taskRunnerHelper'");

code = code.replace("        if (call.name === 'EnterPlanMode') {\n          toolResultContent = await handlePlanModeTool(this.context, this.subAgentManager, this.sessionId)\n          willInjectPlan = Boolean(this.context.features?.activePlan)\n        } else {", "        if (call.name === 'EnterPlanMode') {\n          toolResultContent = await handlePlanModeTool(this.context, this.subAgentManager, this.sessionId)\n          willInjectPlan = Boolean(this.context.features?.activePlan)\n        } else if (call.name === 'Task') {\n          const args = require('../../tools/builtin/TaskTool').TaskTool.handleToolCall(call)\n          toolResultContent = await handleTaskTool(this.context, args, this.subAgentManager, this.sessionId)\n        } else {");

code = code.replace("    SubAgentManager.getInstance().registerDefinition(planDefinition)\n    this.subAgentManager = SubAgentManager.getInstance()", "    SubAgentManager.getInstance().registerDefinition(planDefinition)\n\n    const researchDefinition = require('../definitions/ResearchSubAgent').researchSubAgentDefinition\n    SubAgentManager.getInstance().registerDefinition(researchDefinition)\n\n    this.subAgentManager = SubAgentManager.getInstance()");

fs.writeFileSync(file, code)

