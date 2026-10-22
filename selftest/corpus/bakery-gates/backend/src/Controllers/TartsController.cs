using System.Threading.Tasks;
using Bakery.Gates.Filters;
using Bakery.Gates.Models;
using Bakery.Gates.Services;
using Microsoft.AspNetCore.Mvc;

namespace Bakery.Gates.Controllers
{
    [ApiController]
    [Route("tarts/v1")]
    [CrustCheck]
    public class TartsController : ControllerBase
    {
        private readonly IPastryService _pastries;

        public TartsController(IPastryService pastries)
        {
            _pastries = pastries;
        }

        [HttpPost("bake")]
        public async Task<IActionResult> Bake([FromBody] PastryRequest request)
        {
            await _pastries.BakeAsync(request);
            return Ok();
        }
    }
}
