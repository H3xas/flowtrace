using System.Threading.Tasks;
using Bakery.Gates.Filters;
using Bakery.Gates.Models;
using Bakery.Gates.Services;
using Microsoft.AspNetCore.Mvc;

namespace Bakery.Gates.Controllers
{
    [ApiController]
    [Route("pies/v1")]
    public class PiesController : ControllerBase
    {
        private readonly IPastryService _pastries;

        public PiesController(IPastryService pastries)
        {
            _pastries = pastries;
        }

        [HttpPost("bake")]
        [CrustCheck]
        public async Task<IActionResult> Bake([FromBody] PastryRequest request)
        {
            await _pastries.BakeAsync(request);
            return Ok();
        }

        [HttpGet("menu")]
        [OpenKitchen]
        public async Task<IActionResult> Menu()
        {
            var menu = await _pastries.ListMenuAsync();
            return Ok(menu);
        }
    }
}
