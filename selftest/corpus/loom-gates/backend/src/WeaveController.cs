using System.Threading.Tasks;
using Loom.Gates.Filters;
using Loom.Gates.Services;
using Microsoft.AspNetCore.Mvc;

namespace Loom.Gates.Controllers
{
    [ApiController]
    [Route("looms/v1")]
    public class WeaveController : ControllerBase
    {
        private readonly IBobbinStore _bobbins;

        public WeaveController(IBobbinStore bobbins)
        {
            _bobbins = bobbins;
        }

        [OpenLoom]
        [HttpGet("pattern")]
        public IActionResult Pattern()
        {
            return Ok();
        }

        [HttpPost("spin")]
        public async Task<IActionResult> Spin()
        {
            await _bobbins.Wind();
            return Ok();
        }
    }
}
