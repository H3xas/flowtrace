using System.Threading.Tasks;
using Harbor.Signals.Services;
using Microsoft.AspNetCore.Mvc;

namespace Harbor.Signals.Controllers
{
    [ApiController]
    [Route("lamps/v1")]
    public class LampController : ControllerBase
    {
        private readonly ILamp _lamp;

        public LampController(ILamp lamp)
        {
            _lamp = lamp;
        }

        [HttpPost("flash")]
        public async Task<IActionResult> Flash()
        {
            await _lamp.Flash();
            return Ok();
        }
    }
}
