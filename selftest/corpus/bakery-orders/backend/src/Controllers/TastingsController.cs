using System.Threading.Tasks;
using Bakery.Api.Models;
using Bakery.Api.Services;
using Microsoft.AspNetCore.Mvc;

namespace Bakery.Api.Controllers
{
    [ApiController]
    [Route("bakery/v1/tastings")]
    public class TastingsController : ControllerBase
    {
        private readonly ITastingService _tastings;

        public TastingsController(ITastingService tastings)
        {
            _tastings = tastings;
        }

        [HttpPost]
        public async Task<IActionResult> Approve([FromBody] TastingRequest request)
        {
            var approved = await _tastings.ApproveAsync(request);
            return approved ? Ok(true) : Forbid();
        }

        [HttpPost("preview")]
        public async Task<IActionResult> Preview([FromBody] TastingRequest request)
        {
            var approved = await _tastings.PreviewAsync(request);
            return Ok(new { approved });
        }
    }
}
