using System.Threading.Tasks;
using Bakery.Api.Models;
using Bakery.Api.Services;
using Microsoft.AspNetCore.Mvc;

namespace Bakery.Api.Controllers
{
    [ApiController]
    [Route("bakery/v1/glazes")]
    public class GlazesController : ControllerBase
    {
        private readonly IGlazeService _glazes;

        public GlazesController(IGlazeService glazes)
        {
            _glazes = glazes;
        }

        [HttpPost]
        public async Task<IActionResult> Glaze([FromBody] GlazeRequest request)
        {
            var glazed = await _glazes.GlazeAsync(request);
            return glazed is not null ? Ok(glazed) : BadRequest();
        }

        [HttpPost("sprinkles")]
        public async Task<IActionResult> Sprinkle([FromBody] GlazeRequest request)
        {
            var sprinkled = await _glazes.SprinkleAsync(request);
            return sprinkled is not null ? Ok(sprinkled) : BadRequest();
        }

        [HttpPost("crumbs")]
        public async Task<IActionResult> Crumb([FromBody] GlazeRequest request)
        {
            var crumbed = await _glazes.CrumbAsync(request);
            return crumbed is not null ? Ok(crumbed) : BadRequest();
        }

        [HttpPost("frostings")]
        public async Task<IActionResult> Frost([FromBody] GlazeRequest request)
        {
            var frosted = await _glazes.FrostAsync(request);
            return frosted is not null ? Ok(frosted) : BadRequest();
        }

        [HttpPost("fillings")]
        public async Task<IActionResult> Fill([FromBody] GlazeRequest request)
        {
            var filled = await _glazes.FillAsync(request);
            return filled is not null ? Ok(filled) : BadRequest();
        }

        [HttpPost("toppings")]
        public async Task<IActionResult> Top([FromBody] GlazeRequest request)
        {
            var topped = await _glazes.TopAsync(request);
            return topped is not null ? Ok(topped) : BadRequest();
        }
    }
}
