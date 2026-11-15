using System.Threading.Tasks;
using Quill.Works.Pipelines;
using Microsoft.AspNetCore.Mvc;

namespace Quill.Works.Controllers
{
    [ApiController]
    [Route("seals/v1")]
    public class SealController : ControllerBase
    {
        private readonly ISealPipeline _seals;
        private readonly ITwinStopPipeline _twins;
        private readonly ISweepPipeline _sweeps;

        public SealController(ISealPipeline seals, ITwinStopPipeline twins, ISweepPipeline sweeps)
        {
            _seals = seals;
            _twins = twins;
            _sweeps = sweeps;
        }

        [HttpPost("press")]
        public async Task<IActionResult> Press([FromBody] Seal seal)
        {
            return Ok(await _seals.Run(seal));
        }

        [HttpPost("twin")]
        public async Task<IActionResult> Twin([FromBody] Seal seal)
        {
            await _twins.Run(seal);
            return Ok();
        }

        [HttpPost("sweep")]
        public async Task<IActionResult> Sweep([FromBody] Seal seal)
        {
            await _sweeps.Run(seal);
            return Ok();
        }
    }
}
